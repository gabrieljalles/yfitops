import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  eciesOpen,
  equalBytes,
  fromB64,
  MATCH_TOLERANCE,
  matchKey,
  plain,
  randomBytes,
  randomId,
  searchText,
  sha256,
  toB64,
  IMPORT_HOSTS,
  MAX_SONG_SECONDS,
  TOO_LONG_LOCAL,
  type ImportOpts,
  type ImportRequestInfo,
  type ImportTrackStatus,
  type ItemKind,
  type AccountBilling,
  type ResolvedTrack,
  type SpotFailKind,
  type SpotJob,
  type SignupRequest,
  type SongInfo,
  type SongQuery,
  type DiscoverArtist,
  type DiscoverList,
  type TrackSearchHit,
  type SyncItem,
  type SyncPushItem,
} from "@yfitops/core";

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_URL?: string;
  MAIL_FROM: string;
  /** Limite TOTAL da nuvem (todas as contas juntas), em GB. */
  QUOTA_GB: string;
  /** Dias de acesso grátis a partir da aprovação da conta. */
  TRIAL_DAYS?: string;
  /** Como pagar: aparece para quem está vencido ou perto de vencer. */
  PAYMENT_INFO?: string;
  ESCROW_PRIVATE_KEY: string;
  ESCROW_PUBLIC_KEY: string;
  /** E-mails já aprovados de antemão, separados por vírgula ("@dominio.com" libera o domínio todo). */
  ALLOWED_EMAILS?: string;
  /** Quem vê o painel administrativo (vírgula). Para os outros, o painel não existe. */
  ADMIN_EMAILS?: string;
  /**
   * "on": todo cadastro confirma o e-mail com um código (precisa de domínio no Resend).
   * Desligado: só a aprovação do administrador; o código existe só para o e-mail
   * de administrador (para ninguém criar essa conta antes dele).
   */
  EMAIL_CODES?: string;
  /** Caixa que recebe os e-mails do administrador (códigos, pedidos, links) quando o Resend só entrega nela. */
  ADMIN_MAILBOX?: string;
  /** Consumo no painel: chave da Cloudflare só de leitura de estatísticas (secret). */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  D1_DATABASE_ID: string;
  R2_BUCKET_NAME: string;
  WORKER_NAME: string;
  /** Desenvolvimento: devolve o código de cadastro na resposta (para testes). */
  DEV_MODE?: string;
  RESEND_API_KEY?: string;
}

type App = { Bindings: Env; Variables: { userId: string; email: string; admin: boolean; catalog: boolean } };
type Ctx = Context<App>;

const SESSION_TTL = 1000 * 60 * 60 * 24 * 90; // 90 dias
const RECOVERY_TTL = 1000 * 60 * 60; // 1 hora
const DAY = 1000 * 60 * 60 * 24;
const MAX_SINGLE_UPLOAD = 90 * 1024 * 1024; // limite de corpo do plano gratuito é 100 MB
const ITEM_KINDS: ItemKind[] = ["track", "playlist", "play"];
const ID_RE = /^[A-Za-z0-9_.-]{1,96}$/;

const app = new Hono<App>().basePath("/api");

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Erro interno" }, 500);
});

/**
 * Baixar o APK de dentro do app Android: o app abre links "http://" fora dele (no
 * Chrome), e o Chrome chega aqui e é mandado para o download seguro (https). Aberto, sem login.
 */
app.get("/app/apk", (c) => c.redirect(`https://${new URL(c.req.url).host}/yfitops.apk`, 302));

function fail(status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429 | 502, message: string): never {
  throw new HTTPException(status, { message });
}

function checkId(id: string): string {
  if (!ID_RE.test(id)) fail(400, "ID inválido");
  return id;
}

const normalizeEmail = (e: string) => String(e ?? "").trim().toLowerCase();

async function hashAuthKey(salt: string, authKey: string): Promise<string> {
  return toB64(await sha256(`${salt}:${authKey}`));
}

async function createSession(c: Ctx, userId: string): Promise<string> {
  const token = toB64(randomBytes(32));
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(toB64(await sha256(token)), userId, now, now + SESSION_TTL)
    .run();
  return token;
}

async function sessionResponse(c: Ctx, userId: string) {
  const u = await c.env.DB.prepare(
    "SELECT id, email, wrapped_master_key, wrapped_private_key, public_key, status, phone, paid_until, catalog_access FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<Record<string, string> & BillingRow>();
  if (!u) fail(404, "Conta não encontrada");
  return {
    token: await createSession(c, userId),
    userId: u.id,
    email: u.email,
    wrappedMasterKey: u.wrapped_master_key,
    wrappedPrivateKey: u.wrapped_private_key,
    publicKey: u.public_key,
    status: u.status as "approved" | "pending",
    // Só aparece para quem é administrador: para os outros, o campo nem existe.
    ...(isAdmin(c.env, u.email) && { admin: true as const }),
    ...billing(c.env, u.email, u),
  };
}

// ---------------- Cobrança ----------------

interface BillingRow {
  phone: string | null;
  paid_until: number;
  catalog_access: number;
}

/** Vencimento, celular, como pagar e acesso ao catálogo. Administrador nunca vence e sempre vê o catálogo. */
function billing(env: Env, email: string, u: BillingRow): AccountBilling {
  if (isAdmin(env, email)) return { phone: u.phone, catalog: true };
  return {
    paidUntil: u.paid_until,
    phone: u.phone,
    paymentInfo: env.PAYMENT_INFO ?? "",
    ...(u.catalog_access ? { catalog: true as const } : {}),
  };
}

/** Celular como +55DDDNÚMERO. Sem "+" e sem código do país, assume Brasil. */
function normalizePhone(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (/^55\d{10,11}$/.test(digits)) return `+${digits}`;
  if (/^\d{10,11}$/.test(digits)) return `+55${digits}`;
  return null;
}

/** Fim do período de teste para quem começa agora. */
const trialEnd = (env: Env) => Date.now() + Number(env.TRIAL_DAYS ?? 7) * DAY;

/** Soma meses mantendo o dia (31/01 + 1 mês = 28 ou 29/02, e não 03/03). */
function addMonths(from: number, months: number): number {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

const emailList = (raw: string | undefined) =>
  (raw ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** Administrador = e-mail em ADMIN_EMAILS. */
const isAdmin = (env: Env, email: string) => emailList(env.ADMIN_EMAILS).includes(email.toLowerCase());

// ---------------- Autenticação ----------------

app.get("/auth/config", (c) => c.json({ escrowPublicKey: c.env.ESCROW_PUBLIC_KEY, emailCodes: emailCodes(c.env) }));

const emailCodes = (env: Env) => env.EMAIL_CODES === "on";

/** O cadastro desse e-mail precisa do código? (Sempre, para o administrador.) */
const needsCode = (env: Env, email: string) => emailCodes(env) || isAdmin(env, email);

/** Para onde vai o e-mail de alguém: o do administrador pode ir para a caixa dele (ADMIN_MAILBOX). */
const inbox = (env: Env, email: string) => (!emailCodes(env) && isAdmin(env, email) && env.ADMIN_MAILBOX) || email;

/** "gabriel@gmail.com" → "g•••••l@gmail.com" (para dizer onde o código chegou sem expor o endereço). */
const maskEmail = (e: string) => e.replace(/^(.)(.*)(.)@/, (_, a: string, mid: string, b: string) => `${a}${"•".repeat(Math.min(6, mid.length))}${b}@`);

/** Sem código por e-mail, um limite de pedidos esperando evita que encham o painel. */
const MAX_PENDING = 30;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGNUP_CODE_TTL = 1000 * 60 * 15; // 15 minutos
const SIGNUP_CODE_RESEND = 1000 * 30;
const SIGNUP_CODE_ATTEMPTS = 5;

/**
 * Qualquer pessoa pode pedir para entrar; a conta fica esperando o administrador
 * aceitar. Já entram liberados: o administrador e quem está em ALLOWED_EMAILS
 * (e-mails ou "@dominio.com").
 */
function preApproved(env: Env, email: string): boolean {
  if (isAdmin(env, email)) return true;
  // Sem o código, qualquer um poderia usar um e-mail da lista: aí também espera aprovação.
  return emailCodes(env) && emailList(env.ALLOWED_EMAILS).some((e) => e === email || (e.startsWith("@") && email.endsWith(e)));
}

const signupCodeHash = async (email: string, code: string) => toB64(await sha256(`signup:${email}:${code}`));

/** Etapa 1 do cadastro: diz se precisa de código e, se precisar, envia um de 6 dígitos. */
app.post("/auth/signup/start", async (c) => {
  const { email: raw } = await c.req.json<{ email: string }>();
  const email = normalizeEmail(raw);
  if (!EMAIL_RE.test(email)) fail(400, "E-mail inválido");
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "Este e-mail já tem conta");
  if (!needsCode(c.env, email)) {
    await checkPendingRoom(c.env);
    return c.json({ ok: true, codeRequired: false });
  }

  const prev = await c.env.DB.prepare("SELECT expires_at FROM signup_codes WHERE email = ?").bind(email).first<{ expires_at: number }>();
  if (prev && prev.expires_at - SIGNUP_CODE_TTL + SIGNUP_CODE_RESEND > Date.now()) fail(429, "Aguarde alguns segundos para pedir outro código");

  const n = new DataView(randomBytes(4).buffer).getUint32(0) % 1_000_000;
  const code = String(n).padStart(6, "0");
  await c.env.DB.prepare("INSERT OR REPLACE INTO signup_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)")
    .bind(email, await signupCodeHash(email, code), Date.now() + SIGNUP_CODE_TTL)
    .run();
  const to = inbox(c.env, email);
  const sent = await sendMail(
    c.env,
    to,
    `Seu código do Yfitops: ${code}`,
    `Seu código para criar a conta no Yfitops é:

${code}

Ele vale por 15 minutos. Se não foi você, ignore este e-mail.`,
  );
  if (sent === "failed") fail(502, "Não conseguimos enviar o e-mail agora. Tente de novo em instantes.");
  if (sent === "logged" && !c.env.DEV_MODE) {
    await c.env.DB.prepare("DELETE FROM signup_codes WHERE email = ?").bind(email).run();
    fail(502, "O envio de e-mails ainda não foi configurado no servidor. Fale com quem cuida do app.");
  }
  // Em DEV_MODE o código volta na resposta, para testes e para usar sem e-mail configurado.
  return c.json({
    ok: true,
    codeRequired: true,
    mailed: sent === "sent",
    sentTo: to === email ? email : maskEmail(to),
    ...(c.env.DEV_MODE ? { devCode: code } : {}),
  });
});

async function checkPendingRoom(env: Env) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_PENDING) fail(429, "Muitos pedidos esperando aprovação agora. Tente de novo mais tarde.");
}

/** Etapa 2: confere o código e cria a conta. */
app.post("/auth/signup", async (c) => {
  const body = await c.req.json<SignupRequest>();
  const email = normalizeEmail(body.email);
  if (!EMAIL_RE.test(email)) fail(400, "E-mail inválido");
  for (const k of ["authKey", "wrappedMasterKey", "escrowMasterKey", "publicKey", "wrappedPrivateKey"] as const) {
    if (typeof body[k] !== "string" || !body[k]) fail(400, `Campo ausente: ${k}`);
  }
  const phone = normalizePhone(body.phone);
  if (!phone) fail(400, "Celular inválido. Use DDD + número, ex.: (11) 98765-4321");
  if (needsCode(c.env, email)) {
    const row = await c.env.DB.prepare("SELECT code_hash, expires_at, attempts FROM signup_codes WHERE email = ?")
      .bind(email)
      .first<{ code_hash: string; expires_at: number; attempts: number }>();
    if (!row || row.expires_at < Date.now()) fail(400, "O código expirou. Peça um novo.");
    if (row.attempts >= SIGNUP_CODE_ATTEMPTS) fail(429, "Muitas tentativas. Peça um novo código.");
    const given = await signupCodeHash(email, String(body.code ?? "").replace(/\D/g, ""));
    if (!equalBytes(fromB64(given), fromB64(row.code_hash))) {
      await c.env.DB.prepare("UPDATE signup_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
      fail(400, "Código incorreto");
    }
  } else {
    await checkPendingRoom(c.env);
  }
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "Este e-mail já tem conta");

  const id = randomId();
  const salt = toB64(randomBytes(16));
  const approved = preApproved(c.env, email);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, phone, paid_until, auth_salt, auth_hash, wrapped_master_key, escrow_master_key, public_key, wrapped_private_key, created_at, status, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      email,
      phone,
      // O teste começa quando a conta é liberada: já agora, ou quando o administrador aprovar.
      approved ? trialEnd(c.env) : 0,
      salt,
      await hashAuthKey(salt, body.authKey),
      body.wrappedMasterKey,
      body.escrowMasterKey,
      body.publicKey,
      body.wrappedPrivateKey,
      Date.now(),
      approved ? "approved" : "pending",
      approved ? Date.now() : null,
    ),
    c.env.DB.prepare("DELETE FROM signup_codes WHERE email = ?").bind(email),
  ]);
  // Avisa o administrador que tem gente esperando.
  if (!approved) {
    const base = c.env.APP_URL || new URL(c.req.url).origin;
    for (const admin of emailList(c.env.ADMIN_EMAILS)) {
      c.executionCtx.waitUntil(
        sendMail(c.env, inbox(c.env, admin), `Pedido de acesso ao Yfitops: ${email}`, `${email} pediu para entrar no Yfitops.\n\nPara aceitar ou recusar: ${base}/#/admin`),
      );
    }
  }
  return c.json(await sessionResponse(c, id));
});

app.post("/auth/login", async (c) => {
  const { email, authKey } = await c.req.json<{ email: string; authKey: string }>();
  const u = await c.env.DB.prepare("SELECT id, auth_salt, auth_hash FROM users WHERE email = ?")
    .bind(normalizeEmail(email))
    .first<{ id: string; auth_salt: string; auth_hash: string }>();
  const given = await hashAuthKey(u?.auth_salt ?? "x", String(authKey ?? ""));
  if (!u || !equalBytes(fromB64(given), fromB64(u.auth_hash))) fail(401, "E-mail ou senha incorretos");
  return c.json(await sessionResponse(c, u.id));
});

app.post("/auth/forgot", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  const u = await c.env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(normalizeEmail(email))
    .first<{ id: string; email: string }>();
  // Sempre responde igual, para não revelar quais e-mails têm conta. Sem código por
  // e-mail, só o administrador recebe o link assim; os outros pedem a ele (painel).
  if (u && (emailCodes(c.env) || isAdmin(c.env, u.email))) {
    const link = await recoveryLink(c, u.id);
    c.executionCtx.waitUntil(
      sendMail(
        c.env,
        inbox(c.env, u.email),
        "Redefinir sua senha do Yfitops",
        `Para criar uma nova senha, abra este link (válido por 1 hora):

${link}

Se não foi você, ignore este e-mail.`,
      ),
    );
  }
  return c.json({ ok: true });
});

/** Cria um link de "nova senha" que vale por 1 hora. */
async function recoveryLink(c: Ctx, userId: string): Promise<string> {
  const token = toB64(randomBytes(32));
  await c.env.DB.prepare("INSERT INTO recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(toB64(await sha256(token)), userId, Date.now() + RECOVERY_TTL)
    .run();
  const base = c.env.APP_URL || new URL(c.req.url).origin;
  return `${base}/#/redefinir?token=${token}`;
}

/**
 * Envia e-mail pelo Resend. Sem RESEND_API_KEY, só registra no log e retorna "logged"
 * (útil em desenvolvimento; em produção o cadastro avisa que falta configurar).
 */
async function sendMail(env: Env, to: string, subject: string, text: string): Promise<"sent" | "logged" | "failed"> {
  if (!env.RESEND_API_KEY) {
    console.log(`[e-mail NÃO enviado (sem RESEND_API_KEY) para ${to}] ${subject}
${text}`);
    return "logged";
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }),
  });
  if (!res.ok) console.error("Falha ao enviar e-mail", res.status, await res.text());
  return res.ok ? "sent" : "failed";
}

async function findRecovery(c: Ctx, token: string) {
  const row = await c.env.DB.prepare(
    "SELECT r.token_hash, r.user_id, u.email, u.escrow_master_key FROM recovery_tokens r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used = 0 AND r.expires_at > ?",
  )
    .bind(toB64(await sha256(String(token ?? ""))), Date.now())
    .first<{ token_hash: string; user_id: string; email: string; escrow_master_key: string }>();
  if (!row) fail(400, "Link inválido ou expirado");
  return row;
}

/** Abre a chave mestra pelo escrow para o aparelho re-cifrá-la com a nova senha. */
app.post("/auth/reset/start", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  const row = await findRecovery(c, token);
  const priv = await crypto.subtle.importKey("pkcs8", fromB64(c.env.ESCROW_PRIVATE_KEY), { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const masterKey = await eciesOpen(priv, row.escrow_master_key);
  return c.json({ email: row.email, masterKey: toB64(masterKey) });
});

app.post("/auth/reset/finish", async (c) => {
  const { token, authKey, wrappedMasterKey } = await c.req.json<{ token: string; authKey: string; wrappedMasterKey: string }>();
  if (!authKey || !wrappedMasterKey) fail(400, "Dados incompletos");
  const row = await findRecovery(c, token);
  const salt = toB64(randomBytes(16));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE recovery_tokens SET used = 1 WHERE token_hash = ?").bind(row.token_hash),
    c.env.DB.prepare("UPDATE users SET auth_salt = ?, auth_hash = ?, wrapped_master_key = ? WHERE id = ?").bind(
      salt,
      await hashAuthKey(salt, authKey),
      wrappedMasterKey,
      row.user_id,
    ),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
  ]);
  return c.json(await sessionResponse(c, row.user_id));
});

// ---------------- Rotas autenticadas ----------------

/** Rotas que quem ainda espera aprovação (ou está com o pagamento vencido) pode usar. */
const PENDING_OK = ["/api/auth/me", "/api/auth/logout", "/api/auth/phone"];

/**
 * Com o pagamento vencido, o celular continua ajudando a baixar as músicas que os
 * outros pediram (isso não dá nada para a própria pessoa).
 */
const EXPIRED_OK = (path: string) => PENDING_OK.includes(path) || path.startsWith("/api/spot/");

app.use("/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") && !PENDING_OK.includes(c.req.path)) return next();
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("t") ?? "");
  if (!token) fail(401, "Não autenticado");
  const s = await c.env.DB.prepare(
    "SELECT s.user_id, u.email, u.status, u.paid_until, u.catalog_access FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(toB64(await sha256(token)), Date.now())
    .first<{ user_id: string; email: string; status: string; paid_until: number; catalog_access: number }>();
  if (!s) fail(401, "Sessão expirada");
  if (s.status !== "approved" && !PENDING_OK.includes(c.req.path)) fail(403, "Sua conta ainda espera aprovação");
  const admin = isAdmin(c.env, s.email);
  // Pagamento vencido: nada de tocar, baixar, enviar ou sincronizar até o administrador liberar mais meses.
  if (!admin && s.status === "approved" && s.paid_until < Date.now() && !EXPIRED_OK(c.req.path)) {
    fail(402, "Seu acesso venceu. Faça o pagamento para continuar ouvindo.");
  }
  c.set("userId", s.user_id);
  c.set("email", s.email);
  c.set("admin", admin);
  c.set("catalog", admin || Boolean(s.catalog_access));
  await next();
});

/** Situação da conta (o app pergunta de tempos em tempos enquanto espera aprovação). */
app.get("/auth/me", async (c) => {
  const row = await c.env.DB.prepare("SELECT status, phone, paid_until, catalog_access FROM users WHERE id = ?")
    .bind(c.get("userId"))
    .first<{ status: string } & BillingRow>();
  if (!row) fail(404, "Conta não encontrada");
  const info = { status: row.status, ...billing(c.env, c.get("email"), row) };
  if (!c.get("admin")) return c.json(info);
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first<{ n: number }>();
  return c.json({ ...info, admin: true, pendingRequests: pending?.n ?? 0 });
});

/** Contas criadas antes de o celular ser obrigatório completam o cadastro por aqui. */
app.put("/auth/phone", async (c) => {
  const phone = normalizePhone((await c.req.json<{ phone: string }>()).phone);
  if (!phone) fail(400, "Celular inválido. Use DDD + número, ex.: (11) 98765-4321");
  await c.env.DB.prepare("UPDATE users SET phone = ? WHERE id = ?").bind(phone, c.get("userId")).run();
  return c.json({ phone });
});

app.post("/auth/logout", async (c) => {
  const token = (c.req.header("Authorization") ?? "").slice(7);
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(toB64(await sha256(token))).run();
  return c.json({ ok: true });
});

// ---------------- Sync de metadados ----------------

app.get("/sync", async (c) => {
  const since = Number(c.req.query("since") ?? 0) || 0;
  const limit = 500;
  const { results } = await c.env.DB.prepare(
    "SELECT id, kind, enc, version, deleted, seq FROM items WHERE owner = ? AND seq > ? ORDER BY seq LIMIT ?",
  )
    .bind(c.get("userId"), since, limit + 1)
    .all<Omit<SyncItem, "deleted"> & { deleted: number }>();
  const more = results.length > limit;
  const items: SyncItem[] = results.slice(0, limit).map((r) => ({ ...r, deleted: Boolean(r.deleted) }));
  return c.json({ items, cursor: items.at(-1)?.seq ?? since, more });
});

app.post("/sync", async (c) => {
  const { items } = await c.req.json<{ items: SyncPushItem[] }>();
  if (!Array.isArray(items) || items.length > 200) fail(400, "Lote inválido");
  const owner = c.get("userId");
  const now = Date.now();
  const stmts = items.map((it) => {
    checkId(it.id);
    if (!ITEM_KINDS.includes(it.kind)) fail(400, "Tipo inválido");
    if (!it.deleted && (typeof it.enc !== "string" || it.enc.length > 512 * 1024)) fail(400, "Item inválido");
    // Última escrita vence; seq crescente por dono permite sync incremental.
    return c.env.DB.prepare(
      `INSERT INTO items (owner, id, kind, enc, version, deleted, seq, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE owner = ?1), ?6)
       ON CONFLICT (owner, id) DO UPDATE SET
         kind = excluded.kind, enc = excluded.enc, deleted = excluded.deleted,
         version = items.version + 1, seq = excluded.seq, updated_at = excluded.updated_at`,
    ).bind(owner, it.id, it.kind, it.deleted ? null : it.enc, it.deleted ? 1 : 0, now);
  });
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ---------------- Arquivos (R2) ----------------

const r2Key = (owner: string, id: string) => `${owner}/${id}`;

/**
 * Espaço usado na nuvem inteira (o limite é um só para todos): músicas do
 * catálogo + arquivos criptografados de antes dele. `count` = músicas no catálogo.
 */
async function usage(env: Env) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM songs WHERE status IN ('pending', 'ready')) AS count,
            (SELECT COALESCE(SUM(size + cover_size), 0) FROM songs WHERE status IN ('pending', 'ready'))
              + (SELECT COALESCE(SUM(size), 0) FROM blobs) AS bytes`,
  ).first<{ count: number; bytes: number }>();
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0, quota: Math.floor(Number(env.QUOTA_GB) * 1024 ** 3) };
}

async function checkQuota(c: Ctx, extra: number) {
  const u = await usage(c.env);
  if (u.bytes + extra > u.quota) fail(413, "A nuvem está cheia. Exclua músicas que ninguém ouve mais para liberar espaço.");
}

async function recordBlob(c: Ctx, id: string, size: number) {
  await c.env.DB.prepare("INSERT OR REPLACE INTO blobs (owner, id, size, created_at) VALUES (?, ?, ?, ?)")
    .bind(c.get("userId"), id, size, Date.now())
    .run();
}

app.get("/blobs", async (c) => {
  const u = await usage(c.env);
  // Quantas músicas existem no servidor só aparece para quem pode ver o catálogo.
  return c.json(c.get("catalog") ? u : { bytes: u.bytes, quota: u.quota });
});

app.on("HEAD", "/blobs/:id", async (c) => {
  const head = await c.env.BUCKET.head(r2Key(c.get("userId"), checkId(c.req.param("id"))));
  return c.body(null, head ? 200 : 404);
});

app.put("/blobs/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const size = Number(c.req.header("Content-Length"));
  if (!size || size > MAX_SINGLE_UPLOAD) fail(413, "Use upload em partes");
  await checkQuota(c, size);
  await c.env.BUCKET.put(r2Key(c.get("userId"), id), c.req.raw.body!);
  await recordBlob(c, id, size);
  return c.json({ ok: true });
});

app.post("/blobs/:id/mpu", async (c) => {
  const id = checkId(c.req.param("id"));
  const { size } = await c.req.json<{ size: number }>();
  await checkQuota(c, Number(size) || 0);
  const mpu = await c.env.BUCKET.createMultipartUpload(r2Key(c.get("userId"), id));
  return c.json({ uploadId: mpu.uploadId });
});

app.put("/blobs/:id/mpu/:uploadId/:part", async (c) => {
  const id = checkId(c.req.param("id"));
  const mpu = c.env.BUCKET.resumeMultipartUpload(r2Key(c.get("userId"), id), c.req.param("uploadId"));
  const part = await mpu.uploadPart(Number(c.req.param("part")), c.req.raw.body!);
  return c.json(part);
});

app.post("/blobs/:id/mpu/:uploadId/complete", async (c) => {
  const id = checkId(c.req.param("id"));
  const { parts } = await c.req.json<{ parts: R2UploadedPart[] }>();
  const mpu = c.env.BUCKET.resumeMultipartUpload(r2Key(c.get("userId"), id), c.req.param("uploadId"));
  const obj = await mpu.complete(parts);
  await recordBlob(c, id, obj.size);
  return c.json({ ok: true });
});

app.get("/blobs/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  return serveObject(c, r2Key(c.get("userId"), id), "application/octet-stream");
});

/** Entrega um arquivo do R2, com suporte a Range (o player pula para o meio da música). */
async function serveObject(c: Ctx, key: string, type: string) {
  const obj = await c.env.BUCKET.get(key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
  if (!obj) fail(404, "Arquivo não encontrado");
  const headers = new Headers({
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    ETag: obj.httpEtag,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  const range = obj.range as { offset: number; length: number } | undefined;
  if (range && c.req.header("Range")) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

app.delete("/blobs/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const owner = c.get("userId");
  await c.env.BUCKET.delete(r2Key(owner, id));
  await c.env.DB.prepare("DELETE FROM blobs WHERE owner = ? AND id = ?").bind(owner, id).run();
  return c.json({ ok: true });
});

// ---------------- Catálogo compartilhado ----------------
// Cada música existe uma vez só (MP3, sem criptografia). Antes de enviar ou
// baixar, o app pergunta se ela já existe: aí só liga na biblioteca da pessoa.

const songKey = (id: string, part: "audio" | "cover") => `songs/${id}.${part === "audio" ? "mp3" : "webp"}`;
const SONG_COLS = "s.id, s.artist, s.title, s.album, s.duration, s.size, s.cover_size AS coverSize";
const MAX_SONG = 300 * 1024 * 1024;
const MAX_COVER = 2 * 1024 * 1024;
const HASH_RE = /^[A-Za-z0-9_-]{20,64}$/;
const SOURCE_RE = /^(youtube|spotify|deezer):[A-Za-z0-9_-]{1,64}$/;

const text = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);

function songQuery(body: Partial<SongQuery>): SongQuery {
  return {
    artist: text(body.artist),
    title: text(body.title),
    duration: Math.max(0, Number(body.duration) || 0),
    hash: typeof body.hash === "string" && HASH_RE.test(body.hash) ? body.hash : undefined,
    sources: Array.isArray(body.sources) ? body.sources.filter((x) => typeof x === "string" && SOURCE_RE.test(x)).slice(0, 5) : [],
  };
}

/** Procura no catálogo: mesma origem → mesmo arquivo → mesmo artista/título com duração parecida. */
async function findSong(env: Env, q: SongQuery): Promise<SongInfo | null> {
  if (q.sources?.length) {
    const hit = await env.DB.prepare(
      `SELECT ${SONG_COLS} FROM song_sources ss JOIN songs s ON s.id = ss.song_id
       WHERE ss.source IN (${q.sources.map(() => "?").join(",")}) AND s.status = 'ready' LIMIT 1`,
    )
      .bind(...q.sources)
      .first<SongInfo>();
    if (hit) return hit;
  }
  if (q.hash) {
    const hit = await env.DB.prepare(`SELECT ${SONG_COLS} FROM songs s WHERE s.source_hash = ? AND s.status = 'ready' LIMIT 1`)
      .bind(q.hash)
      .first<SongInfo>();
    if (hit) return hit;
  }
  // Sem duração não dá para saber se é a mesma gravação: melhor não juntar.
  if (!q.title || !q.duration) return null;
  return env.DB.prepare(
    `SELECT ${SONG_COLS} FROM songs s WHERE s.match_key = ? AND s.status = 'ready' AND ABS(s.duration - ?) <= ?
     ORDER BY ABS(s.duration - ?), s.created_at LIMIT 1`,
  )
    .bind(matchKey(q.artist, q.title), q.duration, MATCH_TOLERANCE, q.duration)
    .first<SongInfo>();
}

/** Lembra as origens da música (a próxima pessoa que importar o mesmo link nem baixa). */
function addSources(env: Env, songId: string, sources: string[] = []) {
  return sources.map((src) => env.DB.prepare("INSERT OR IGNORE INTO song_sources (source, song_id) VALUES (?, ?)").bind(src, songId));
}

type SongRow = SongInfo & { status: string; mergedInto: string | null; uploadedBy: string };

/** Segue as junções de duplicadas até a música que ficou. */
async function liveSong(env: Env, id: string): Promise<SongRow | null> {
  for (let i = 0; i < 5; i++) {
    const row = await env.DB.prepare(
      `SELECT ${SONG_COLS}, s.status, s.merged_into AS mergedInto, s.uploaded_by AS uploadedBy FROM songs s WHERE s.id = ?`,
    )
      .bind(id)
      .first<SongRow>();
    if (!row) return null;
    if (row.status !== "merged" || !row.mergedInto) return row;
    id = row.mergedInto;
  }
  return null;
}

/** Já existe? (antes de converter ou baixar) */
app.post("/songs/match", async (c) => {
  return c.json({ song: await findSong(c.env, songQuery(await c.req.json())) });
});

/**
 * Registra uma música nova antes do envio. Se ela já existir (alguém enviou
 * enquanto este aparelho convertia), devolve a existente e nada é enviado.
 */
app.post("/songs", async (c) => {
  const body = await c.req.json<SongQuery & { album?: string; size: number; coverSize?: number }>();
  const q = songQuery(body);
  if (!q.title) fail(400, "Música sem título");
  if (q.duration > MAX_SONG_SECONDS) fail(413, "Músicas com mais de 13 minutos não entram no yfitops");
  const size = Number(body.size) || 0;
  const coverSize = Number(body.coverSize) || 0;
  if (size <= 0 || size > MAX_SONG) fail(413, "Arquivo de música grande demais");
  if (coverSize < 0 || coverSize > MAX_COVER) fail(413, "Capa grande demais");

  const existing = await findSong(c.env, q);
  if (existing) {
    const add = addSources(c.env, existing.id, q.sources);
    if (add.length) await c.env.DB.batch(add);
    return c.json({ song: existing, created: false });
  }
  await checkQuota(c, size + coverSize);
  const song: SongInfo = { id: randomId(), artist: q.artist, title: q.title, album: text(body.album), duration: q.duration, size, coverSize };
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO songs (id, match_key, search, artist, title, album, duration, size, cover_size, source_hash, status, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      song.id,
      matchKey(song.artist, song.title),
      searchText(song.artist, song.title, song.album),
      song.artist,
      song.title,
      song.album,
      song.duration,
      size,
      coverSize,
      q.hash ?? null,
      c.get("userId"),
      Date.now(),
    ),
    ...addSources(c.env, song.id, q.sources),
  ]);
  return c.json({ song, created: true });
});

/** Música ainda sendo enviada por quem está pedindo. */
async function pendingSong(c: Ctx) {
  const id = checkId(c.req.param("id") ?? "");
  const row = await c.env.DB.prepare("SELECT size, cover_size AS coverSize FROM songs WHERE id = ? AND status = 'pending' AND uploaded_by = ?")
    .bind(id, c.get("userId"))
    .first<{ size: number; coverSize: number }>();
  if (!row) fail(404, "Envio não encontrado (talvez já tenha terminado)");
  return { id, ...row };
}

app.put("/songs/:id/audio", async (c) => {
  const song = await pendingSong(c);
  const size = Number(c.req.header("Content-Length"));
  if (size !== song.size) fail(400, "Tamanho diferente do registrado");
  if (size > MAX_SINGLE_UPLOAD) fail(413, "Use upload em partes");
  await c.env.BUCKET.put(songKey(song.id, "audio"), c.req.raw.body!, { httpMetadata: { contentType: "audio/mpeg" } });
  return c.json({ ok: true });
});

app.put("/songs/:id/cover", async (c) => {
  const song = await pendingSong(c);
  const size = Number(c.req.header("Content-Length"));
  if (!song.coverSize || size !== song.coverSize) fail(400, "Tamanho diferente do registrado");
  await c.env.BUCKET.put(songKey(song.id, "cover"), c.req.raw.body!, { httpMetadata: { contentType: "image/webp" } });
  return c.json({ ok: true });
});

app.post("/songs/:id/mpu", async (c) => {
  const song = await pendingSong(c);
  const mpu = await c.env.BUCKET.createMultipartUpload(songKey(song.id, "audio"), { httpMetadata: { contentType: "audio/mpeg" } });
  return c.json({ uploadId: mpu.uploadId });
});

app.put("/songs/:id/mpu/:uploadId/:part", async (c) => {
  const song = await pendingSong(c);
  const mpu = c.env.BUCKET.resumeMultipartUpload(songKey(song.id, "audio"), c.req.param("uploadId"));
  return c.json(await mpu.uploadPart(Number(c.req.param("part")), c.req.raw.body!));
});

app.post("/songs/:id/mpu/:uploadId/complete", async (c) => {
  const song = await pendingSong(c);
  const { parts } = await c.req.json<{ parts: R2UploadedPart[] }>();
  const mpu = c.env.BUCKET.resumeMultipartUpload(songKey(song.id, "audio"), c.req.param("uploadId"));
  await mpu.complete(parts);
  return c.json({ ok: true });
});

/** Envio terminado: confere os arquivos e põe a música no catálogo. */
app.post("/songs/:id/done", async (c) => {
  const song = await pendingSong(c);
  const audio = await c.env.BUCKET.head(songKey(song.id, "audio"));
  if (!audio || audio.size !== song.size) fail(400, "O arquivo da música não chegou inteiro");
  if (song.coverSize) {
    const cover = await c.env.BUCKET.head(songKey(song.id, "cover"));
    if (!cover || cover.size !== song.coverSize) fail(400, "A capa não chegou inteira");
  }
  await c.env.DB.prepare("UPDATE songs SET status = 'ready' WHERE id = ?").bind(song.id).run();
  return c.json({ ok: true });
});

/**
 * Busca no catálogo por artista, título ou álbum. Só para quem o administrador liberou:
 * as outras contas não ficam sabendo o que existe no servidor.
 */
app.get("/songs/search", async (c) => {
  if (!c.get("catalog")) return c.notFound();
  const words = plain(c.req.query("q") ?? "").split(" ").filter(Boolean).slice(0, 6);
  if (!words.length) return c.json({ songs: [] });
  const { results } = await c.env.DB.prepare(
    `SELECT ${SONG_COLS} FROM songs s WHERE s.status = 'ready' AND ${words.map(() => "s.search LIKE ?").join(" AND ")}
     ORDER BY s.artist, s.title LIMIT 40`,
  )
    .bind(...words.map((w) => `%${w}%`))
    .all<SongInfo>();
  return c.json({ songs: results });
});

/** O áudio (MP3) ou a capa. Duplicadas já juntadas entregam a música que ficou. */
app.get("/songs/:id/:part{audio|cover}", async (c) => {
  const part = c.req.param("part") as "audio" | "cover";
  const song = await liveSong(c.env, checkId(c.req.param("id")));
  if (!song || song.status === "removed" || (song.status === "pending" && song.uploadedBy !== c.get("userId"))) {
    fail(404, "Música não encontrada");
  }
  if (part === "cover" && !song.coverSize) fail(404, "Música sem capa");
  return serveObject(c, songKey(song.id, part), part === "audio" ? "audio/mpeg" : "image/webp");
});

/** Quais destas músicas foram juntadas a outra (o app troca na biblioteca). */
app.post("/songs/resolve", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!Array.isArray(ids) || ids.length > 5000) fail(400, "Lista inválida");
  await recordOwners(c, ids);
  const merged: Record<string, SongInfo> = {};
  const removed: string[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90).filter((x) => typeof x === "string" && ID_RE.test(x));
    if (!slice.length) continue;
    const { results } = await c.env.DB.prepare(
      `SELECT id, status FROM songs WHERE status IN ('merged', 'removed') AND id IN (${slice.map(() => "?").join(",")})`,
    )
      .bind(...slice)
      .all<{ id: string; status: string }>();
    for (const r of results) {
      const live = r.status === "merged" ? await liveSong(c.env, r.id) : null;
      // Apagada pelo administrador (ou juntada a uma que depois foi apagada): sai das bibliotecas.
      if (!live || live.status === "removed") {
        removed.push(r.id);
        continue;
      }
      const { status: _s, mergedInto: _m, uploadedBy: _u, ...info } = live;
      merged[r.id] = info;
    }
  }
  return c.json({ merged, removed });
});

/**
 * A lista que o app manda é a biblioteca inteira (só as músicas do catálogo): ela
 * substitui o que a conta tinha antes. É assim que a faxina sabe que música ficou sem dono.
 */
async function recordOwners(c: Ctx, ids: unknown[]) {
  const me = c.get("userId");
  const valid = [...new Set(ids.filter((x): x is string => typeof x === "string" && ID_RE.test(x)))];
  const stmts = [c.env.DB.prepare("DELETE FROM song_owners WHERE user_id = ?").bind(me)];
  // Até 45 músicas por comando (o D1 aceita até 100 valores por comando).
  for (let i = 0; i < valid.length; i += 45) {
    const slice = valid.slice(i, i + 45);
    stmts.push(
      c.env.DB.prepare(`INSERT OR IGNORE INTO song_owners (user_id, song_id) VALUES ${slice.map(() => "(?, ?)").join(", ")}`).bind(
        ...slice.flatMap((id) => [me, id]),
      ),
    );
  }
  stmts.push(c.env.DB.prepare("UPDATE users SET library_reported_at = ? WHERE id = ?").bind(Date.now(), me));
  await c.env.DB.batch(stmts);
}

/** Músicas sem dono ficam assim alguns dias antes de sair (dá tempo de alguém trazer de volta). */
const ORPHAN_GRACE = 3 * 24 * 60 * 60 * 1000;

/** Uma música tem dono: alguém a tem na biblioteca (ou uma duplicada que foi juntada nela), ou ainda vai receber de um pedido. */
const HAS_OWNER = `(
  EXISTS (SELECT 1 FROM song_owners o WHERE o.song_id = songs.id)
  OR EXISTS (SELECT 1 FROM song_owners o JOIN songs m ON m.id = o.song_id WHERE m.merged_into = songs.id)
  OR EXISTS (SELECT 1 FROM import_tracks t WHERE t.song_id = songs.id AND t.delivered = 0)
)`;

/** Contas aprovadas que ainda não informaram suas músicas (enquanto houver, nada sem dono é apagado). */
async function ownersWaiting(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT email FROM users WHERE status = 'approved' AND library_reported_at IS NULL ORDER BY email").all<{
    email: string;
  }>();
  return results.map((r) => r.email);
}

/**
 * Apaga músicas que ninguém tem na biblioteca há mais de ORPHAN_GRACE. Só roda
 * quando todas as contas já informaram suas músicas pelo menos uma vez.
 */
async function removeOrphans(env: Env): Promise<{ orphans: number; waiting: string[] }> {
  const waiting = await ownersWaiting(env);
  if (waiting.length) return { orphans: 0, waiting };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE songs SET orphan_since = NULL WHERE status = 'ready' AND orphan_since IS NOT NULL AND ${HAS_OWNER}`),
    // Envios de menos de 1 dia ainda podem estar chegando na biblioteca de quem pediu.
    env.DB.prepare(`UPDATE songs SET orphan_since = ? WHERE status = 'ready' AND orphan_since IS NULL AND created_at < ? AND NOT ${HAS_OWNER}`).bind(
      now,
      now - 24 * 60 * 60 * 1000,
    ),
  ]);
  const { results } = await env.DB.prepare("SELECT id FROM songs WHERE status = 'ready' AND orphan_since < ? LIMIT 500")
    .bind(now - ORPHAN_GRACE)
    .all<{ id: string }>();
  for (let i = 0; i < results.length; i += 90) await removeSongs(env, results.slice(i, i + 90).map((r) => r.id));
  return { orphans: results.length, waiting };
}

/**
 * Faxina diária (Cron): junta músicas duplicadas que escaparam na hora do envio
 * (ex.: duas pessoas enviando ao mesmo tempo) e apaga envios abandonados.
 */
async function tidyCatalog(env: Env) {
  // Envios que nunca terminaram (mais de 1 dia).
  const { results: stale } = await env.DB.prepare("SELECT id FROM songs WHERE status = 'pending' AND created_at < ? LIMIT 200")
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .all<{ id: string }>();
  for (const { id } of stale) {
    await env.BUCKET.delete([songKey(id, "audio"), songKey(id, "cover")]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM song_sources WHERE song_id = ?").bind(id),
      env.DB.prepare("DELETE FROM songs WHERE id = ?").bind(id),
    ]);
  }

  // Duplicadas: mesmo artista/título/versão e duração parecida.
  const { results: groups } = await env.DB.prepare(
    "SELECT match_key AS k FROM songs WHERE status = 'ready' GROUP BY match_key HAVING COUNT(*) > 1 LIMIT 200",
  ).all<{ k: string }>();
  let merged = 0;
  for (const { k } of groups) {
    // Fica a que tem capa e, empatando, a mais antiga.
    const { results: rows } = await env.DB.prepare(
      "SELECT id, duration FROM songs WHERE match_key = ? AND status = 'ready' ORDER BY (cover_size > 0) DESC, created_at",
    )
      .bind(k)
      .all<{ id: string; duration: number }>();
    const keep: typeof rows = [];
    for (const r of rows) {
      const into = keep.find((x) => Math.abs(x.duration - r.duration) <= MATCH_TOLERANCE);
      if (!into) {
        keep.push(r);
        continue;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE songs SET status = 'merged', merged_into = ? WHERE id = ?").bind(into.id, r.id),
        env.DB.prepare("UPDATE songs SET merged_into = ? WHERE merged_into = ?").bind(into.id, r.id),
        env.DB.prepare("UPDATE OR IGNORE song_sources SET song_id = ? WHERE song_id = ?").bind(into.id, r.id),
        env.DB.prepare("DELETE FROM song_sources WHERE song_id = ?").bind(r.id),
      ]);
      await env.BUCKET.delete([songKey(r.id, "audio"), songKey(r.id, "cover")]);
      merged++;
    }
  }
  // Pedidos de importação esquecidos (mais de 30 dias) e celulares que não aparecem há uma semana.
  const month = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM import_tracks WHERE request_id IN (SELECT id FROM import_requests WHERE created_at < ?)").bind(month),
    env.DB.prepare("DELETE FROM import_requests WHERE created_at < ?").bind(month),
    env.DB.prepare("DELETE FROM import_devices WHERE last_seen < ?").bind(Date.now() - 7 * 24 * 60 * 60 * 1000),
  ]);
  // Músicas que ninguém tem mais na biblioteca.
  const { orphans, waiting } = await removeOrphans(env);
  console.log(
    `faxina do catálogo: ${stale.length} envios abandonados, ${merged} duplicadas juntadas, ${orphans} sem dono apagadas` +
      (waiting.length ? ` (sem dono: esperando ${waiting.length} conta(s) abrirem o app)` : ""),
  );
  return { abandoned: stale.length, merged, orphans, waiting };
}

// ---------------- Painel administrativo ----------------
// Só para ADMIN_EMAILS. Para os outros, estas rotas respondem igual a uma rota
// que não existe: ninguém fica sabendo que o painel existe.

app.use("/admin/*", async (c, next) => {
  if (!c.get("admin")) return c.notFound();
  await next();
});

/** Apaga a conta e tudo dela (biblioteca, arquivos criptografados, compartilhamentos). As músicas do catálogo ficam. */
async function deleteUser(env: Env, id: string) {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `${id}/`, cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM import_tracks WHERE request_id IN (SELECT id FROM import_requests WHERE user_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM import_requests WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM import_devices WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM items WHERE owner = ?").bind(id),
    env.DB.prepare("DELETE FROM song_owners WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM blobs WHERE owner = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM recovery_tokens WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM signup_codes WHERE email = (SELECT email FROM users WHERE id = ?)").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
}

/** Pessoas (pedidos de acesso primeiro) e o espaço da nuvem. */
app.get("/admin/overview", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.status, u.created_at AS createdAt, u.phone, u.paid_until AS paidUntil, u.catalog_access AS catalogAccess,
            (SELECT COUNT(*) FROM songs s WHERE s.uploaded_by = u.id AND s.status = 'ready') AS songs,
            (SELECT COALESCE(SUM(s.size + s.cover_size), 0) FROM songs s WHERE s.uploaded_by = u.id AND s.status = 'ready') AS bytes,
            (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id) AS lastLogin
     FROM users u ORDER BY (u.status = 'pending') DESC, u.created_at DESC`,
  ).all<{
    id: string;
    email: string;
    status: string;
    createdAt: number;
    phone: string | null;
    paidUntil: number;
    catalogAccess: number;
    songs: number;
    bytes: number;
    lastLogin: number | null;
  }>();
  return c.json({
    usage: await usage(c.env),
    paymentInfo: c.env.PAYMENT_INFO ?? "",
    // Faxina de músicas sem dono: só começa quando todos já abriram o app.
    ownersWaiting: await ownersWaiting(c.env),
    users: results.map(({ catalogAccess, ...u }) => {
      const admin = isAdmin(c.env, u.email);
      return { ...u, admin, catalog: admin || Boolean(catalogAccess), me: u.id === c.get("userId") };
    }),
  });
});

app.post("/admin/users/:id/approve", async (c) => {
  const id = checkId(c.req.param("id"));
  const u = await c.env.DB.prepare("SELECT email FROM users WHERE id = ? AND status = 'pending'").bind(id).first<{ email: string }>();
  if (!u) fail(404, "Pedido não encontrado");
  // O período de teste começa agora, na aprovação.
  await c.env.DB.prepare("UPDATE users SET status = 'approved', approved_at = ?, paid_until = MAX(paid_until, ?) WHERE id = ?")
    .bind(Date.now(), trialEnd(c.env), id)
    .run();
  const base = c.env.APP_URL || new URL(c.req.url).origin;
  c.executionCtx.waitUntil(sendMail(c.env, u.email, "Seu acesso ao Yfitops foi liberado", `Pode entrar: ${base}`));
  return c.json({ ok: true });
});

/**
 * Libera meses de acesso, contados do vencimento atual (ou de agora, se já venceu),
 * para quem renova antes do fim não perder dias. Com "block", corta o acesso na hora.
 */
app.post("/admin/users/:id/access", async (c) => {
  const id = checkId(c.req.param("id"));
  const { months, block } = await c.req.json<{ months?: number; block?: boolean }>();
  const u = await c.env.DB.prepare("SELECT paid_until FROM users WHERE id = ? AND status = 'approved'").bind(id).first<{ paid_until: number }>();
  if (!u) fail(404, "Conta não encontrada");
  let paidUntil = Date.now();
  if (!block) {
    const n = Number(months);
    if (!Number.isInteger(n) || n < 1 || n > 36) fail(400, "Escolha de 1 a 36 meses");
    paidUntil = addMonths(Math.max(Date.now(), u.paid_until), n);
  }
  await c.env.DB.prepare("UPDATE users SET paid_until = ? WHERE id = ?").bind(paidUntil, id).run();
  return c.json({ paidUntil });
});

/** Libera (ou tira) a busca no catálogo inteiro. */
app.post("/admin/users/:id/catalog", async (c) => {
  const id = checkId(c.req.param("id"));
  const { allowed } = await c.req.json<{ allowed: boolean }>();
  const res = await c.env.DB.prepare("UPDATE users SET catalog_access = ? WHERE id = ?").bind(allowed ? 1 : 0, id).run();
  if (!res.meta.changes) fail(404, "Conta não encontrada");
  return c.json({ ok: true });
});

/** Link de "nova senha" para mandar à pessoa (por mensagem): vale por 1 hora. */
app.post("/admin/users/:id/reset-link", async (c) => {
  const id = checkId(c.req.param("id"));
  const u = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'approved'").bind(id).first();
  if (!u) fail(404, "Conta não encontrada");
  return c.json({ link: await recoveryLink(c, id) });
});

/** Recusa um pedido ou tira o acesso de alguém (a conta é apagada). */
app.delete("/admin/users/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  if (id === c.get("userId")) fail(400, "Você não pode apagar a própria conta por aqui");
  const u = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(id).first<{ email: string }>();
  if (!u) return c.json({ ok: true });
  if (isAdmin(c.env, u.email)) fail(400, "Não dá para apagar outro administrador");
  await deleteUser(c.env, id);
  return c.json({ ok: true });
});

/** Músicas do catálogo, com quem enviou. */
app.get("/admin/songs", async (c) => {
  const words = plain(c.req.query("q") ?? "").split(" ").filter(Boolean).slice(0, 6);
  const order = { size: "s.size + s.cover_size DESC", title: "s.artist, s.title", recent: "s.created_at DESC" }[c.req.query("sort") ?? ""] ?? "s.created_at DESC";
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const PAGE = 50;
  const { results } = await c.env.DB.prepare(
    `SELECT ${SONG_COLS}, s.created_at AS createdAt, u.email AS uploadedBy
     FROM songs s LEFT JOIN users u ON u.id = s.uploaded_by
     WHERE s.status = 'ready' ${words.map(() => "AND s.search LIKE ?").join(" ")}
     ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...words.map((w) => `%${w}%`), PAGE + 1, offset)
    .all<SongInfo & { createdAt: number; uploadedBy: string | null }>();
  return c.json({ songs: results.slice(0, PAGE), more: results.length > PAGE });
});

/** Apaga músicas do sistema: somem da nuvem e da biblioteca de todos. */
async function removeSongs(env: Env, ids: string[]) {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT id FROM songs WHERE id IN (${marks}) AND status != 'removed'`)
    .bind(...ids)
    .all<{ id: string }>();
  const live = results.map((r) => r.id);
  if (!live.length) return;
  await env.BUCKET.delete(live.flatMap((id) => [songKey(id, "audio"), songKey(id, "cover")]));
  const in_ = live.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(`UPDATE songs SET status = 'removed' WHERE id IN (${in_})`).bind(...live),
    env.DB.prepare(`DELETE FROM song_sources WHERE song_id IN (${in_})`).bind(...live),
  ]);
}

app.delete("/admin/songs/:id", async (c) => {
  await removeSongs(c.env, [checkId(c.req.param("id"))]);
  return c.json({ ok: true });
});

/** Várias de uma vez (seleção no painel): até 100 por pedido. */
app.post("/admin/songs/delete", async (c) => {
  const { ids } = await c.req.json<{ ids: unknown }>();
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) fail(400, "Escolha de 1 a 100 músicas");
  await removeSongs(c.env, [...new Set(ids.map((id) => checkId(String(id))))]);
  return c.json({ ok: true });
});

/** Roda a faxina do catálogo agora (normalmente roda sozinha de madrugada). */
app.post("/admin/tidy", async (c) => c.json(await tidyCatalog(c.env)));

// ---------------- Consumo da Cloudflare (painel) ----------------
// Os números vêm da própria Cloudflare (API de Analytics): são os mesmos que ela
// usa para cobrar. Só é consultado quando o administrador clica em "atualizar".

/** Operações do R2 que contam como Classe A (gravar/listar) e Classe B (ler). Apagar é grátis. */
const R2_CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption",
  "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

interface GqlDay<T> {
  sum: T;
  dimensions: { date?: string; actionType?: string };
}

app.post("/admin/consumption", async (c) => {
  const env = c.env;
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return c.json({ configured: false });

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedDays = Math.max(1 / 24, (now.getTime() - start.getTime()) / 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const q = (v: string) => JSON.stringify(v);

  // Valores no próprio texto (são nossos, não vêm de quem usa o app).
  const query = `{
    viewer { accounts(filter: { accountTag: ${q(env.CF_ACCOUNT_ID)} }) {
      ops: r2OperationsAdaptiveGroups(limit: 10000, filter: {
        datetime_geq: ${q(start.toISOString())}, datetime_leq: ${q(now.toISOString())}, bucketName: ${q(env.R2_BUCKET_NAME)}
      }) { sum { requests } dimensions { actionType } }
      storage: r2StorageAdaptiveGroups(limit: 1, orderBy: [datetime_DESC], filter: {
        datetime_geq: ${q(new Date(now.getTime() - 3 * 86_400_000).toISOString())}, datetime_leq: ${q(now.toISOString())}, bucketName: ${q(env.R2_BUCKET_NAME)}
      }) { max { payloadSize metadataSize objectCount } dimensions { datetime } }
      workers: workersInvocationsAdaptive(limit: 100, filter: {
        scriptName: ${q(env.WORKER_NAME)}, datetime_geq: ${q(start.toISOString())}, datetime_leq: ${q(now.toISOString())}
      }) { sum { requests } dimensions { date } }
      d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: {
        date_geq: ${q(day(start))}, date_leq: ${q(day(now))}, databaseId: ${q(env.D1_DATABASE_ID)}
      }) { sum { rowsRead rowsWritten } dimensions { date } }
    } }
  }`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: { viewer?: { accounts?: Record<string, unknown>[] } };
    errors?: { message: string; path?: string[] }[] | null;
  };
  const acc = (body.data?.viewer?.accounts?.[0] ?? {}) as {
    ops?: GqlDay<{ requests: number }>[];
    storage?: { max: { payloadSize: number; metadataSize: number; objectCount: number } }[];
    workers?: GqlDay<{ requests: number }>[];
    d1?: GqlDay<{ rowsRead: number; rowsWritten: number }>[];
  };
  if (!res.ok && !body.data) fail(502, `A Cloudflare não respondeu (${res.status})`);

  let classA = 0;
  let classB = 0;
  for (const g of acc.ops ?? []) {
    const action = g.dimensions.actionType ?? "";
    if (R2_CLASS_A.has(action)) classA += g.sum.requests;
    else if (R2_CLASS_B.has(action)) classB += g.sum.requests;
  }
  const stored = acc.storage?.[0]?.max;
  // Por dia: o Worker e o D1 têm limites diários.
  const perDay = <T>(rows: GqlDay<T>[] | undefined, pick: (s: T) => number) => {
    const days = new Map<string, number>();
    for (const r of rows ?? []) days.set(r.dimensions.date ?? "", (days.get(r.dimensions.date ?? "") ?? 0) + pick(r.sum));
    const values = [...days.values()];
    return { month: values.reduce((a, b) => a + b, 0), today: days.get(day(now)) ?? 0, maxDay: Math.max(0, ...values) };
  };

  return c.json({
    configured: true,
    updatedAt: now.getTime(),
    month: { start: start.getTime(), daysInMonth, elapsedDays },
    r2: {
      classA,
      classB,
      storedBytes: stored ? stored.payloadSize + stored.metadataSize : null,
      objects: stored?.objectCount ?? null,
    },
    workers: perDay(acc.workers, (s) => s.requests),
    d1Read: perDay(acc.d1, (s) => s.rowsRead),
    d1Written: perDay(acc.d1, (s) => s.rowsWritten),
    // O que o próprio app soma (músicas no catálogo), para comparar.
    app: await usage(env),
    errors: (body.errors ?? []).map((e) => `${(e.path ?? []).join(".")}: ${e.message}`),
  });
});

// ---------------- Fila de importação por link ----------------
// Quem pede só manda o link. Celulares Android com o app aberto (ou tocando
// música) e no Wi-Fi pedem trabalho aqui: primeiro ler o link (vira uma música
// por linha), depois baixar cada música e enviar ao catálogo. Revezam: quem
// acabou de baixar passa a vez para o celular que espera há mais tempo.

/** Celular que não pediu trabalho nesse tempo saiu (fechou o app, parou a música, saiu do Wi-Fi). */
const SPOT_ACTIVE = 90_000;
/** Download que não terminou nesse tempo volta para a fila (o celular saiu no meio). */
const SPOT_STALE = 10 * 60_000;
/** Tentativas por música antes de desistir. */
const SPOT_ATTEMPTS = 3;
/** O YouTube barrou o celular: ele descansa esse tempo e os outros seguem. */
const SPOT_REST = 30 * 60_000;
/** Pedidos em aberto por pessoa, e músicas por link. */
const MAX_OPEN_REQUESTS = 20;
const MAX_LINK_TRACKS = 300;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

function checkDevice(id: unknown): string {
  if (typeof id !== "string" || !DEVICE_RE.test(id)) fail(400, "Aparelho inválido");
  return id;
}

/** Faixa lida de um link, só com os campos esperados e tamanhos limitados. */
function cleanTrack(m: Partial<ResolvedTrack>): ResolvedTrack {
  const id = (v: unknown) => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : undefined);
  const url = (v: unknown) => (typeof v === "string" && /^https:\/\/[\w.-]+\/\S{1,500}$/.test(v) ? v : undefined);
  const t: ResolvedTrack = {
    videoId: id(m.videoId) ?? "",
    title: text(m.title) || "Faixa sem título",
    artist: text(m.artist),
    duration: Math.max(0, Number(m.duration) || 0),
  };
  const query = text(m.query);
  const album = text(m.album);
  const cover = url(m.cover);
  const spotifyId = id(m.spotifyId);
  const deezerId = id(m.deezerId);
  return {
    ...t,
    ...(query && { query }),
    ...(album && { album }),
    ...(cover && { cover }),
    ...(spotifyId && { spotifyId }),
    ...(deezerId && { deezerId }),
  };
}

/** Pede a importação de um link. */
app.post("/imports", async (c) => {
  const body = await c.req.json<{ url: string; opts?: ImportOpts }>();
  const url = text(body.url, 600);
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* inválido */
  }
  if (!IMPORT_HOSTS.test(host)) fail(400, "Só aceitamos links do YouTube, do Spotify ou do Deezer");
  const tags = Array.isArray(body.opts?.tags)
    ? body.opts.tags
        .filter((t) => typeof t === "string")
        .map((t) => text(t, 40))
        .slice(0, 20)
    : [];
  const opts: ImportOpts = { tags, playlist: body.opts?.playlist !== false };
  // Só contam os que ainda esperam ou estão baixando (os prontos não seguram ninguém).
  const open = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM import_requests r WHERE r.user_id = ? AND (r.status IN ('queued', 'listing')
       OR EXISTS (SELECT 1 FROM import_tracks t WHERE t.request_id = r.id AND t.status IN ('queued', 'working')))`,
  )
    .bind(c.get("userId"))
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_REQUESTS) fail(429, `Você já tem ${MAX_OPEN_REQUESTS} pedidos esperando. Espere alguns chegarem.`);
  const id = randomId();
  await c.env.DB.prepare("INSERT INTO import_requests (id, user_id, url, opts, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, c.get("userId"), url, JSON.stringify(opts), Date.now())
    .run();
  return c.json({ id });
});

type RequestRow = {
  id: string;
  url: string;
  opts: string;
  status: ImportRequestInfo["status"];
  provider: string | null;
  source: string | null;
  name: string | null;
  truncated: number;
  error: string | null;
  createdAt: number;
};
type TrackRow = {
  progress: number;
  id: string;
  requestId: string;
  pos: number;
  meta: string;
  status: ImportTrackStatus;
  error: string | null;
  delivered: number;
  songId: string | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  duration: number | null;
  size: number | null;
  coverSize: number | null;
};

/** Os links que a pessoa pediu, com cada música (e a do catálogo, quando terminou). */
app.get("/imports", async (c) => {
  const db = c.env.DB;
  const { results: reqs } = await db
    .prepare(
      `SELECT id, url, opts, status, provider, source, name, truncated, error, created_at AS createdAt
       FROM import_requests WHERE user_id = ? ORDER BY created_at`,
    )
    .bind(c.get("userId"))
    .all<RequestRow>();
  let tracks: TrackRow[] = [];
  if (reqs.length) {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.request_id AS requestId, t.pos, t.meta, t.status, t.error, t.delivered, t.progress, t.song_id AS songId,
                s.artist, s.title, s.album, s.duration, s.size, s.cover_size AS coverSize
         FROM import_tracks t LEFT JOIN songs s ON s.id = t.song_id
         WHERE t.request_id IN (${reqs.map(() => "?").join(",")}) ORDER BY t.request_id, t.pos`,
      )
      .bind(...reqs.map((r) => r.id))
      .all<TrackRow>();
    tracks = results;
  }
  const requests: ImportRequestInfo[] = reqs.map((r) => ({
    id: r.id,
    url: r.url,
    opts: JSON.parse(r.opts) as ImportOpts,
    status: r.status,
    ...(r.provider && { provider: r.provider }),
    ...(r.source && { source: r.source }),
    ...(r.name && { name: r.name }),
    truncated: !!r.truncated,
    ...(r.error && { error: r.error }),
    createdAt: r.createdAt,
    tracks: tracks
      .filter((t) => t.requestId === r.id)
      .map((t) => ({
        id: t.id,
        pos: t.pos,
        meta: JSON.parse(t.meta) as ResolvedTrack,
        status: t.status,
        ...(t.error && { error: t.error }),
        ...(t.songId &&
          t.title !== null && {
            song: {
              id: t.songId,
              artist: t.artist ?? "",
              title: t.title,
              album: t.album ?? "",
              duration: t.duration ?? 0,
              size: t.size ?? 0,
              coverSize: t.coverSize ?? 0,
            },
          }),
        delivered: !!t.delivered,
        ...(t.status === "working" && { progress: t.progress }),
      })),
  }));
  const now = Date.now();
  const helpers = await db
    .prepare("SELECT COUNT(*) AS n FROM import_devices WHERE last_seen > ? AND blocked_until <= ?")
    .bind(now - SPOT_ACTIVE, now)
    .first<{ n: number }>();
  return c.json({ requests, helpers: helpers?.n ?? 0 });
});

/** Pedido da própria pessoa. */
async function ownRequest(c: Ctx) {
  const id = checkId(c.req.param("id") ?? "");
  const row = await c.env.DB.prepare("SELECT id FROM import_requests WHERE id = ? AND user_id = ?").bind(id, c.get("userId")).first();
  if (!row) fail(404, "Pedido não encontrado");
  return id;
}

const trackIdList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID_RE.test(x)).slice(0, MAX_LINK_TRACKS) : [];

/** As músicas já entraram na biblioteca de quem pediu. */
app.post("/imports/:id/delivered", async (c) => {
  const id = await ownRequest(c);
  const ids = trackIdList((await c.req.json<{ tracks: string[] }>()).tracks);
  if (ids.length)
    await c.env.DB.prepare(`UPDATE import_tracks SET delivered = 1 WHERE request_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(id, ...ids)
      .run();
  return c.json({ ok: true });
});

/** Ignora músicas que ainda não foram baixadas. */
app.post("/imports/:id/skip", async (c) => {
  const id = await ownRequest(c);
  const ids = trackIdList((await c.req.json<{ tracks: string[] }>()).tracks);
  if (ids.length)
    await c.env.DB.prepare(
      `UPDATE import_tracks SET status = 'skipped' WHERE request_id = ? AND status = 'queued' AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(id, ...ids)
      .run();
  return c.json({ ok: true });
});

/** Tenta de novo as que falharam ou foram ignoradas (ou o link inteiro, se nem a leitura deu). */
app.post("/imports/:id/retry", async (c) => {
  const id = await ownRequest(c);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE import_tracks SET status = 'queued', error = NULL, attempts = 0 WHERE request_id = ? AND status IN ('failed', 'skipped')",
    ).bind(id),
    c.env.DB.prepare("UPDATE import_requests SET status = 'queued', error = NULL, attempts = 0 WHERE id = ? AND status = 'failed'").bind(id),
  ]);
  return c.json({ ok: true });
});

/** Cancela o pedido (o que ainda não foi baixado não será) ou o tira da lista depois de pronto. */
app.delete("/imports/:id", async (c) => {
  const id = await ownRequest(c);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM import_tracks WHERE request_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM import_requests WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

/**
 * Um celular pede trabalho (e avisa que está disponível). Responde com um link
 * para ler, uma música para baixar, ou nada (e quantos segundos esperar).
 *
 * `mineOnly` (nos dados móveis, com o app aberto): só os pedidos da própria
 * pessoa. O celular não entra no revezamento nem baixa para os outros.
 * `helper` (celular ajudante, 24 horas): não pega as músicas longas da própria
 * conta, que ficam no celular de quem pediu (o principal).
 */
app.post("/spot/claim", async (c) => {
  const body = await c.req.json<{ device: string; mineOnly?: boolean; helper?: boolean }>();
  const device = checkDevice(body.device);
  const mineOnly = body.mineOnly === true;
  const helper = body.helper === true;
  const userId = c.get("userId");
  const db = c.env.DB;
  const now = Date.now();
  const results = await db.batch([
    // Só nos dados móveis, o celular não conta como disponível (last_seen = 0): a vez não para nele.
    db
      .prepare(
        `INSERT INTO import_devices (id, user_id, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, user_id = excluded.user_id`,
      )
      .bind(device, userId, mineOnly ? 0 : now),
    // Este celular está livre: o que ele tinha em mãos (o app fechou no meio) volta para a fila.
    db.prepare("UPDATE import_tracks SET status = 'queued', device = NULL, attempts = attempts + 1 WHERE status = 'working' AND device = ?").bind(device),
    // Downloads largados no meio por outros celulares voltam para a fila; depois de algumas tentativas, falham.
    db
      .prepare(
        `UPDATE import_tracks SET device = NULL, attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ?1 THEN 'failed' ELSE 'queued' END,
           error = CASE WHEN attempts + 1 >= ?1 THEN 'Não deu para baixar agora. Tente de novo mais tarde.' ELSE error END
         WHERE status = 'working' AND claimed_at < ?2`,
      )
      .bind(SPOT_ATTEMPTS, now - SPOT_STALE),
    db
      .prepare(
        `UPDATE import_requests SET device = NULL, attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ?1 THEN 'failed' ELSE 'queued' END,
           error = CASE WHEN attempts + 1 >= ?1 THEN 'Não deu para ler o link agora. Tente de novo mais tarde.' ELSE error END
         WHERE status = 'listing' AND (claimed_at < ?2 OR device = ?3)`,
      )
      .bind(SPOT_ATTEMPTS, now - SPOT_STALE, device),
    db.prepare("SELECT blocked_until AS blockedUntil FROM import_devices WHERE id = ?").bind(device),
  ]);
  const blockedUntil = (results[4].results[0] as { blockedUntil: number } | undefined)?.blockedUntil ?? 0;
  if (blockedUntil > now) return c.json({ job: null, wait: Math.ceil((blockedUntil - now) / 1000), resting: true });

  // Ler um link é rápido e não baixa áudio: qualquer celular pega.
  const list = await db
    .prepare(
      `UPDATE import_requests SET status = 'listing', device = ?1, claimed_at = ?2
       WHERE id = (SELECT id FROM import_requests WHERE status = 'queued' AND (?3 = 0 OR user_id = ?4) ORDER BY created_at LIMIT 1)
         AND status = 'queued'
       RETURNING id, url`,
    )
    .bind(device, now, mineOnly ? 1 : 0, userId)
    .first<{ id: string; url: string }>();
  if (list) return c.json({ job: { type: "list", id: list.id, url: list.url } satisfies SpotJob });

  if (mineOnly) {
    // Qualquer música do próprio pedido (curta ou longa), na ordem da lista.
    const own = await db
      .prepare(
        `UPDATE import_tracks SET status = 'working', device = ?, claimed_at = ?, progress = 0
         WHERE id = (SELECT t.id FROM import_tracks t JOIN import_requests r ON r.id = t.request_id
                     WHERE t.status = 'queued' AND r.user_id = ? ORDER BY t.pos, r.created_at LIMIT 1) AND status = 'queued'
         RETURNING id, request_id AS requestId, meta`,
      )
      .bind(device, now, userId)
      .first<{ id: string; requestId: string; meta: string }>();
    if (!own) return c.json({ job: null, wait: 20 });
    return c.json({ job: { type: "track", id: own.id, requestId: own.requestId, meta: JSON.parse(own.meta), mine: true } satisfies SpotJob });
  }

  if (!(await db.prepare("SELECT 1 FROM import_tracks WHERE status = 'queued' LIMIT 1").first())) return c.json({ job: null, wait: 60 });

  // Mais de 13 minutos não vai para o servidor: só o celular de quem pediu baixa (e fica com ela).
  // Ele pega na hora, sem esperar a vez: nenhum outro celular pode baixar essa.
  const mine = helper ? null : await db
    .prepare(
      `UPDATE import_tracks SET status = 'working', device = ?, claimed_at = ?, progress = 0
       WHERE id = (SELECT t.id FROM import_tracks t JOIN import_requests r ON r.id = t.request_id
                   WHERE t.status = 'queued' AND r.user_id = ? AND ${LONG_TRACK}
                   ORDER BY t.pos, r.created_at LIMIT 1) AND status = 'queued'
       RETURNING id, request_id AS requestId, meta`,
    )
    .bind(device, now, userId)
    .first<{ id: string; requestId: string; meta: string }>();
  if (mine) return c.json({ job: { type: "track", id: mine.id, requestId: mine.requestId, meta: JSON.parse(mine.meta), mine: true } satisfies SpotJob });

  // Revezamento: a vez é do celular livre que espera há mais tempo desde o último download.
  const turn = await db
    .prepare(
      `SELECT d.id FROM import_devices d
       WHERE d.last_seen > ? AND d.blocked_until <= ?
         AND NOT EXISTS (SELECT 1 FROM import_tracks t WHERE t.status = 'working' AND t.device = d.id)
       ORDER BY d.last_done_at, d.id LIMIT 1`,
    )
    .bind(now - SPOT_ACTIVE, now)
    .first<{ id: string }>();
  if (turn && turn.id !== device) return c.json({ job: null, wait: 15 });

  // Uma música de cada link por vez (a 1ª de cada, depois a 2ª...): um link grande não segura os outros.
  const track = await db
    .prepare(
      `UPDATE import_tracks SET status = 'working', device = ?, claimed_at = ?, progress = 0
       WHERE id = (SELECT t.id FROM import_tracks t JOIN import_requests r ON r.id = t.request_id
                   WHERE t.status = 'queued' AND NOT ${LONG_TRACK} ORDER BY t.pos, r.created_at LIMIT 1) AND status = 'queued'
       RETURNING id, request_id AS requestId, meta`,
    )
    .bind(device, now)
    .first<{ id: string; requestId: string; meta: string }>();
  if (!track) return c.json({ job: null, wait: 15 });
  const owner = await db.prepare("SELECT user_id AS userId FROM import_requests WHERE id = ?").bind(track.requestId).first<{ userId: string }>();
  return c.json({
    job: { type: "track", id: track.id, requestId: track.requestId, meta: JSON.parse(track.meta), mine: owner?.userId === userId } satisfies SpotJob,
  });
});

/** Faixa que se sabe ter mais de 13 minutos (a duração vem do link ou de quem já tentou baixar). */
const LONG_TRACK = `COALESCE(json_extract(t.meta, '$.duration'), 0) > ${MAX_SONG_SECONDS}`;

/** Quanto do download já andou (0 a 100): quem pediu vê a barra andar. */
app.post("/spot/progress/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const body = await c.req.json<{ device: string; progress: number }>();
  const device = checkDevice(body.device);
  const progress = Math.max(0, Math.min(99, Math.round(Number(body.progress) || 0)));
  await c.env.DB.prepare("UPDATE import_tracks SET progress = ? WHERE id = ? AND device = ? AND status = 'working'")
    .bind(progress, id, device)
    .run();
  return c.json({ ok: true });
});

/** O celular parou de ajudar (pausou a música, saiu do app ou do Wi-Fi): a vez passa na hora. */
app.post("/spot/leave", async (c) => {
  const device = checkDevice((await c.req.json<{ device: string }>()).device);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE import_devices SET last_seen = 0 WHERE id = ? AND user_id = ?").bind(device, c.get("userId")),
    c.env.DB.prepare("UPDATE import_tracks SET status = 'queued', device = NULL WHERE status = 'working' AND device = ?").bind(device),
    c.env.DB.prepare("UPDATE import_requests SET status = 'queued', device = NULL WHERE status = 'listing' AND device = ?").bind(device),
  ]);
  return c.json({ ok: true });
});

/** O que fazer com uma falha: descansar o celular, tentar de novo ou desistir. */
function failure(env: Env, table: "import_tracks" | "import_requests", id: string, device: string, kind: SpotFailKind, error: string) {
  const db = env.DB;
  const now = Date.now();
  const out = [db.prepare("UPDATE import_devices SET last_done_at = ? WHERE id = ?").bind(now, device)];
  if (kind === "limit") out.push(db.prepare("UPDATE import_devices SET blocked_until = ? WHERE id = ?").bind(now + SPOT_REST, device));
  out.push(
    kind === "gone"
      ? db.prepare(`UPDATE ${table} SET status = 'failed', error = ?, device = NULL WHERE id = ?`).bind(error, id)
      : db
          .prepare(
            `UPDATE ${table} SET device = NULL, attempts = attempts + 1,
               status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'queued' END, error = ? WHERE id = ?`,
          )
          // Barrado pelo YouTube não é culpa da música: outro celular ainda tenta.
          .bind(kind === "limit" ? SPOT_ATTEMPTS + 2 : SPOT_ATTEMPTS, error, id),
  );
  return db.batch(out);
}

const failKind = (k: unknown): SpotFailKind => (k === "limit" || k === "gone" ? k : "temp");

/** O celular leu o link: cada música vira uma linha da fila (as que já estão no catálogo já saem prontas). */
app.post("/spot/list/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const body = await c.req.json<{
    device: string;
    error?: string;
    kind?: SpotFailKind;
    provider?: string;
    source?: string;
    name?: string;
    truncated?: boolean;
    tracks?: { meta: ResolvedTrack; songId?: string }[];
  }>();
  const device = checkDevice(body.device);
  const db = c.env.DB;
  const req = await db.prepare("SELECT 1 FROM import_requests WHERE id = ? AND status = 'listing' AND device = ?").bind(id, device).first();
  if (!req) fail(409, "Esse link não está mais com este aparelho");
  if (body.error) {
    await failure(c.env, "import_requests", id, device, failKind(body.kind), text(body.error));
    return c.json({ ok: true });
  }
  const tracks = (body.tracks ?? []).slice(0, MAX_LINK_TRACKS);
  if (!tracks.length) {
    await failure(c.env, "import_requests", id, device, "gone", "Não achei músicas nesse link");
    return c.json({ ok: true });
  }
  const source =
    typeof body.source === "string" && /^(youtube|spotify|deezer)-playlist:[\w-]{1,80}$/.test(body.source) ? body.source : null;
  const inserts = tracks.map((t, pos) => {
    const songId = typeof t.songId === "string" && ID_RE.test(t.songId) ? t.songId : null;
    return db
      .prepare("INSERT INTO import_tracks (id, request_id, pos, meta, status, song_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(randomId(), id, pos, JSON.stringify(cleanTrack(t.meta ?? {})), songId ? "done" : "queued", songId);
  });
  await db.batch([
    db.prepare("DELETE FROM import_tracks WHERE request_id = ?").bind(id),
    ...inserts,
    db
      .prepare(
        "UPDATE import_requests SET status = 'listed', provider = ?, source = ?, name = ?, truncated = ?, error = NULL, device = NULL WHERE id = ?",
      )
      .bind(text(body.provider, 20) || null, source, text(body.name) || null, body.truncated ? 1 : 0, id),
  ]);
  return c.json({ ok: true });
});

/** O celular terminou (ou não conseguiu) uma música. */
app.post("/spot/track/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const body = await c.req.json<{ device: string; songId?: string; error?: string; kind?: SpotFailKind; tooLong?: boolean; local?: boolean; duration?: number }>();
  const device = checkDevice(body.device);
  const db = c.env.DB;
  const row = await db.prepare("SELECT 1 FROM import_tracks WHERE id = ? AND status = 'working' AND device = ?").bind(id, device).first();
  if (!row) fail(409, "Essa música não está mais com este aparelho");
  // Baixou, mas passa de 13 minutos: não vai para o servidor.
  if (body.tooLong) {
    const owner = await db
      .prepare("SELECT 1 FROM import_tracks t JOIN import_requests r ON r.id = t.request_id WHERE t.id = ? AND r.user_id = ?")
      .bind(id, c.get("userId"))
      .first();
    await db.batch([
      owner && body.local
        ? // O celular de quem pediu ficou com ela.
          db.prepare("UPDATE import_tracks SET status = 'skipped', error = ?, device = NULL WHERE id = ?").bind(TOO_LONG_LOCAL, id)
        : // Outro celular descobriu a duração ao baixar: volta para a fila, agora só para o celular de quem pediu.
          db
            .prepare("UPDATE import_tracks SET status = 'queued', device = NULL, meta = json_set(meta, '$.duration', ?) WHERE id = ?")
            .bind(Math.max(MAX_SONG_SECONDS + 1, Math.round(Number(body.duration) || 0)), id),
      db.prepare("UPDATE import_devices SET last_done_at = ? WHERE id = ?").bind(Date.now(), device),
    ]);
    return c.json({ ok: true });
  }
  if (body.error || !body.songId) {
    await failure(c.env, "import_tracks", id, device, failKind(body.kind), text(body.error) || "Não consegui baixar");
    return c.json({ ok: true });
  }
  const songId = checkId(body.songId);
  if (!(await db.prepare("SELECT 1 FROM songs WHERE id = ? AND status = 'ready'").bind(songId).first())) fail(400, "A música não está no catálogo");
  await db.batch([
    db.prepare("UPDATE import_tracks SET status = 'done', song_id = ?, error = NULL, device = NULL WHERE id = ?").bind(songId, id),
    db.prepare("UPDATE import_devices SET last_done_at = ? WHERE id = ?").bind(Date.now(), device),
  ]);
  return c.json({ ok: true });
});

/**
 * Quem canta essa música? (quando o arquivo não traz e o nome não diz). Procura
 * no Deezer e no iTunes, e só aceita um resultado com o mesmo título: um artista
 * errado é pior que "Artista desconhecido".
 */
/**
 * Busca de músicas pelo nome, no catálogo público do Deezer (o servidor não consegue
 * buscar no YouTube). Quem pede escolhe uma e ela vira um pedido normal pelo link do Deezer.
 */
app.get("/search/tracks", async (c) => {
  const q = text(c.req.query("q"), 120);
  if (q.length < 2) return c.json({ tracks: [] });
  let res: Response;
  try {
    res = await fetch(`https://api.deezer.com/search?limit=20&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
  } catch {
    fail(502, "A busca não respondeu agora. Tente de novo ou cole um link.");
  }
  if (!res.ok) fail(502, "A busca não respondeu agora. Tente de novo ou cole um link.");
  const dz = await res.json<{ data?: DeezerTrack[] }>();
  return c.json({ tracks: deezerHits(dz.data) });
});

// ---------------- Descobrir ----------------
// Músicas que a pessoa ainda não tem, vindas só do Deezer (as paradas e os artistas
// parecidos). Nada aqui olha o catálogo do servidor: ninguém fica sabendo se uma
// música já existia. Pedir uma delas é um pedido normal pelo link do Deezer.

/** Paradas do Deezer (playlists dos editores, que não dependem do país de quem pergunta). */
const DISCOVER_LISTS: [key: string, name: string, playlist: number][] = [
  ["brasil", "Em alta no Brasil", 1111141961],
  ["mundo", "Em alta no mundo", 3155776842],
  ["sertanejo", "Sertanejo", 5207214368],
  ["funk", "Funk", 9743264302],
  ["pagode", "Pagode", 1335664985],
  ["forro", "Forró e piseiro", 6880421184],
  ["gospel", "Gospel", 2532050928],
  ["pop", "Pop", 1310668095],
  ["trap", "Rap e trap", 5656652602],
  ["internacional", "Internacional", 948759923],
  ["rock", "Rock nacional", 9268293682],
  ["mpb", "MPB", 556502217],
  ["eletronica", "Eletrônica", 6275031904],
];

type DeezerTrack = {
  id?: number;
  title?: string;
  readable?: boolean;
  duration?: number;
  preview?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string };
};

const deezerHit = (t: DeezerTrack): TrackSearchHit => ({
  id: String(t.id),
  title: t.title!,
  artist: t.artist?.name ?? "",
  album: t.album?.title ?? "",
  duration: t.duration ?? 0,
  cover: t.album?.cover_medium ?? null,
  url: `https://www.deezer.com/track/${t.id}`,
  ...(t.preview && { preview: true }),
});

const deezerHits = (data: DeezerTrack[] | undefined) => (data ?? []).filter((t) => t.id && t.title && t.readable !== false).map(deezerHit);

/** GET no Deezer guardado no cache da Cloudflare (as paradas mudam uma vez por dia). */
async function deezerCached<T>(path: string, seconds: number): Promise<T> {
  const url = `https://api.deezer.com${path}`;
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit.json<T>();
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    fail(502, "O Descobrir não respondeu agora. Tente de novo daqui a pouco.");
  }
  if (!res.ok) fail(502, "O Descobrir não respondeu agora. Tente de novo daqui a pouco.");
  const body = await res.text();
  if (/"error"\s*:/.test(body.slice(0, 40))) fail(502, "O Descobrir não respondeu agora. Tente de novo daqui a pouco.");
  await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` } }));
  return JSON.parse(body) as T;
}

app.get("/discover/lists", (c) => c.json({ lists: DISCOVER_LISTS.map(([key, name]) => ({ key, name }) satisfies DiscoverList) }));

app.get("/discover/list/:key", async (c) => {
  const list = DISCOVER_LISTS.find(([key]) => key === c.req.param("key"));
  if (!list) fail(404, "Lista não encontrada");
  const dz = await deezerCached<{ data?: DeezerTrack[] }>(`/playlist/${list[2]}/tracks?limit=50`, 6 * 60 * 60);
  return c.json({ key: list[0], name: list[1], tracks: deezerHits(dz.data) });
});

/** As mais famosas de um artista (pelo nome) e artistas parecidos. */
app.get("/discover/artist", async (c) => {
  const name = text(c.req.query("name"), 120);
  if (name.length < 2) fail(400, "Artista inválido");
  const found = await deezerCached<{ data?: { id?: number; name?: string }[] }>(`/search/artist?limit=1&q=${encodeURIComponent(name)}`, 7 * 24 * 60 * 60);
  const artist = found.data?.[0];
  if (!artist?.id) return c.json({ artist: name, tracks: [], related: [] } satisfies DiscoverArtist);
  const [top, related] = await Promise.all([
    deezerCached<{ data?: DeezerTrack[] }>(`/artist/${artist.id}/top?limit=15`, 24 * 60 * 60),
    deezerCached<{ data?: { name?: string }[] }>(`/artist/${artist.id}/related?limit=6`, 7 * 24 * 60 * 60).catch(() => ({ data: [] })),
  ]);
  return c.json({
    artist: artist.name ?? name,
    tracks: deezerHits(top.data),
    related: (related.data ?? []).map((a) => a.name ?? "").filter(Boolean),
  } satisfies DiscoverArtist);
});

/** Prévia de 30 segundos (o link do Deezer expira em minutos: pede um novo na hora). */
app.get("/discover/preview/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d{1,15}$/.test(id)) fail(400, "Música inválida");
  const t = await deezerCached<DeezerTrack>(`/track/${id}`, 10 * 60);
  if (!t.preview) fail(404, "Essa música não tem prévia");
  return c.json({ url: t.preview });
});

app.get("/lookup/artist", async (c) => {
  const title = text(c.req.query("title"), 200);
  if (!title) return c.json({ artist: "" });
  const norm = (s: string) =>
    plain(s.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/\b(official|video|audio|lyrics?|letra|clipe|hd|4k|remaster(ed)?|feat\.?|ft\.?)\b/gi, " "));
  const same = (a: string) => {
    const x = norm(a);
    const y = norm(title);
    return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
  };
  const get = async (url: string): Promise<Record<string, unknown>> => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : {};
  };
  try {
    const dz = await get(`https://api.deezer.com/search?limit=10&q=${encodeURIComponent(title)}`);
    const hit = ((dz.data ?? []) as { title?: string; title_short?: string; artist?: { name?: string } }[]).find(
      (t) => same(t.title_short ?? t.title ?? "") && t.artist?.name,
    );
    if (hit?.artist?.name) return c.json({ artist: hit.artist.name });
  } catch {
    /* tenta o iTunes */
  }
  try {
    const it = await get(`https://itunes.apple.com/search?media=music&entity=song&limit=10&term=${encodeURIComponent(title)}`);
    const hit = ((it.results ?? []) as { trackName?: string; artistName?: string }[]).find((t) => same(t.trackName ?? "") && t.artistName);
    if (hit?.artistName) return c.json({ artist: hit.artistName });
  } catch {
    /* sem resposta: fica "Artista desconhecido" */
  }
  return c.json({ artist: "" });
});

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tidyCatalog(env));
  },
} satisfies ExportedHandler<Env>;
