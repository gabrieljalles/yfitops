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
  type ItemKind,
  type ShareInfo,
  type SignupRequest,
  type SongInfo,
  type SongQuery,
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
  ESCROW_PRIVATE_KEY: string;
  ESCROW_PUBLIC_KEY: string;
  /** E-mails convidados, separados por vírgula ("@dominio.com" libera o domínio todo). */
  ALLOWED_EMAILS?: string;
  /** Desenvolvimento: devolve o código de cadastro na resposta (para testes). */
  DEV_MODE?: string;
  RESEND_API_KEY?: string;
}

type App = { Bindings: Env; Variables: { userId: string } };
type Ctx = Context<App>;

const SESSION_TTL = 1000 * 60 * 60 * 24 * 90; // 90 dias
const RECOVERY_TTL = 1000 * 60 * 60; // 1 hora
const MAX_SINGLE_UPLOAD = 90 * 1024 * 1024; // limite de corpo do plano gratuito é 100 MB
const ITEM_KINDS: ItemKind[] = ["track", "playlist", "play"];
const ID_RE = /^[A-Za-z0-9_.-]{1,96}$/;

const app = new Hono<App>().basePath("/api");

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Erro interno" }, 500);
});

function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502, message: string): never {
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
    "SELECT id, email, wrapped_master_key, wrapped_private_key, public_key FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<Record<string, string>>();
  if (!u) fail(404, "Conta não encontrada");
  return {
    token: await createSession(c, userId),
    userId: u.id,
    email: u.email,
    wrappedMasterKey: u.wrapped_master_key,
    wrappedPrivateKey: u.wrapped_private_key,
    publicKey: u.public_key,
  };
}

// ---------------- Autenticação ----------------

app.get("/auth/config", (c) => c.json({ escrowPublicKey: c.env.ESCROW_PUBLIC_KEY }));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGNUP_CODE_TTL = 1000 * 60 * 15; // 15 minutos
const SIGNUP_CODE_RESEND = 1000 * 30;
const SIGNUP_CODE_ATTEMPTS = 5;

/** Convite = e-mail na lista ALLOWED_EMAILS (e-mails ou "@dominio.com"). Sem lista, qualquer um pode criar conta. */
function isInvited(env: Env, email: string): boolean {
  const list = (env.ALLOWED_EMAILS ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !list.length || list.some((e) => e === email || (e.startsWith("@") && email.endsWith(e)));
}

const signupCodeHash = async (email: string, code: string) => toB64(await sha256(`signup:${email}:${code}`));

/** Etapa 1 do cadastro: envia um código de 6 dígitos para o e-mail. */
app.post("/auth/signup/start", async (c) => {
  const { email: raw } = await c.req.json<{ email: string }>();
  const email = normalizeEmail(raw);
  if (!EMAIL_RE.test(email)) fail(400, "E-mail inválido");
  if (!isInvited(c.env, email)) fail(403, "Este e-mail não foi convidado. Peça para quem cuida do app adicionar você.");
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "Este e-mail já tem conta");

  const prev = await c.env.DB.prepare("SELECT expires_at FROM signup_codes WHERE email = ?").bind(email).first<{ expires_at: number }>();
  if (prev && prev.expires_at - SIGNUP_CODE_TTL + SIGNUP_CODE_RESEND > Date.now()) fail(429, "Aguarde alguns segundos para pedir outro código");

  const n = new DataView(randomBytes(4).buffer).getUint32(0) % 1_000_000;
  const code = String(n).padStart(6, "0");
  await c.env.DB.prepare("INSERT OR REPLACE INTO signup_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)")
    .bind(email, await signupCodeHash(email, code), Date.now() + SIGNUP_CODE_TTL)
    .run();
  const sent = await sendMail(
    c.env,
    email,
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
  return c.json({ ok: true, mailed: sent === "sent", ...(c.env.DEV_MODE ? { devCode: code } : {}) });
});

/** Etapa 2: confere o código e cria a conta. */
app.post("/auth/signup", async (c) => {
  const body = await c.req.json<SignupRequest>();
  const email = normalizeEmail(body.email);
  if (!EMAIL_RE.test(email)) fail(400, "E-mail inválido");
  for (const k of ["authKey", "wrappedMasterKey", "escrowMasterKey", "publicKey", "wrappedPrivateKey"] as const) {
    if (typeof body[k] !== "string" || !body[k]) fail(400, `Campo ausente: ${k}`);
  }
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
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "Este e-mail já tem conta");

  const id = randomId();
  const salt = toB64(randomBytes(16));
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, auth_salt, auth_hash, wrapped_master_key, escrow_master_key, public_key, wrapped_private_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      email,
      salt,
      await hashAuthKey(salt, body.authKey),
      body.wrappedMasterKey,
      body.escrowMasterKey,
      body.publicKey,
      body.wrappedPrivateKey,
      Date.now(),
    ),
    c.env.DB.prepare("DELETE FROM signup_codes WHERE email = ?").bind(email),
  ]);
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
  // Sempre responde igual, para não revelar quais e-mails têm conta.
  if (u) {
    const token = toB64(randomBytes(32));
    await c.env.DB.prepare("INSERT INTO recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(toB64(await sha256(token)), u.id, Date.now() + RECOVERY_TTL)
      .run();
    const base = c.env.APP_URL || new URL(c.req.url).origin;
    const link = `${base}/#/redefinir?token=${token}`;
    c.executionCtx.waitUntil(
      sendMail(
        c.env,
        u.email,
        "Redefinir sua senha do Yfitops",
        `Para criar uma nova senha, abra este link (válido por 1 hora):

${link}

Se não foi você, ignore este e-mail.`,
      ),
    );
  }
  return c.json({ ok: true });
});

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

app.use("/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") && c.req.path !== "/api/auth/logout") return next();
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("t") ?? "");
  if (!token) fail(401, "Não autenticado");
  const s = await c.env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(toB64(await sha256(token)), Date.now())
    .first<{ user_id: string }>();
  if (!s) fail(401, "Sessão expirada");
  c.set("userId", s.user_id);
  await next();
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
    `SELECT (SELECT COUNT(*) FROM songs WHERE status != 'merged') AS count,
            (SELECT COALESCE(SUM(size + cover_size), 0) FROM songs WHERE status != 'merged')
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

app.get("/blobs", async (c) => c.json(await usage(c.env)));

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

/** Dono do blob: o próprio usuário ou alguém que compartilhou um grupo com ele. */
async function resolveBlobOwner(c: Ctx, id: string): Promise<string> {
  const me = c.get("userId");
  const owner = c.req.query("owner") || me;
  if (owner === me) return me;
  const ok = await c.env.DB.prepare(
    "SELECT 1 FROM share_blobs b JOIN shares s ON s.id = b.share_id WHERE b.owner = ? AND b.blob_id = ? AND s.to_user = ? LIMIT 1",
  )
    .bind(owner, id, me)
    .first();
  if (!ok) fail(403, "Sem acesso a este arquivo");
  return owner;
}

app.get("/blobs/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const owner = await resolveBlobOwner(c, id);
  return serveObject(c, r2Key(owner, id), "application/octet-stream");
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

/** Busca no catálogo por artista, título ou álbum. */
app.get("/songs/search", async (c) => {
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
  if (!song || (song.status === "pending" && song.uploadedBy !== c.get("userId"))) fail(404, "Música não encontrada");
  if (part === "cover" && !song.coverSize) fail(404, "Música sem capa");
  return serveObject(c, songKey(song.id, part), part === "audio" ? "audio/mpeg" : "image/webp");
});

/** Quais destas músicas foram juntadas a outra (o app troca na biblioteca). */
app.post("/songs/resolve", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!Array.isArray(ids) || ids.length > 5000) fail(400, "Lista inválida");
  const merged: Record<string, SongInfo> = {};
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90).filter((x) => typeof x === "string" && ID_RE.test(x));
    if (!slice.length) continue;
    const { results } = await c.env.DB.prepare(`SELECT id FROM songs WHERE status = 'merged' AND id IN (${slice.map(() => "?").join(",")})`)
      .bind(...slice)
      .all<{ id: string }>();
    for (const r of results) {
      const live = await liveSong(c.env, r.id);
      if (!live) continue;
      const { status: _s, mergedInto: _m, uploadedBy: _u, ...info } = live;
      merged[r.id] = info;
    }
  }
  return c.json({ merged });
});

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
  console.log(`faxina do catálogo: ${stale.length} envios abandonados, ${merged} duplicadas juntadas`);
}

// ---------------- Compartilhamento ----------------

app.get("/users/lookup", async (c) => {
  const u = await c.env.DB.prepare("SELECT id, email, public_key FROM users WHERE email = ?")
    .bind(normalizeEmail(c.req.query("email") ?? ""))
    .first<{ id: string; email: string; public_key: string }>();
  if (!u) fail(404, "Ninguém com esse e-mail");
  return c.json({ userId: u.id, email: u.email, publicKey: u.public_key });
});

app.get("/shares", async (c) => {
  const me = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.from_user AS fromUser, f.email AS fromEmail, s.to_user AS toUser, t.email AS toEmail,
            s.payload, s.updated_at AS updatedAt
     FROM shares s JOIN users f ON f.id = s.from_user JOIN users t ON t.id = s.to_user
     WHERE s.to_user = ? OR s.from_user = ? ORDER BY s.updated_at DESC`,
  )
    .bind(me, me)
    .all<ShareInfo>();
  return c.json({ shares: results });
});

app.put("/shares/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const me = c.get("userId");
  const { toUser, payload, blobIds } = await c.req.json<{ toUser: string; payload: string; blobIds: string[] }>();
  if (typeof payload !== "string" || payload.length > 4 * 1024 * 1024) fail(400, "Compartilhamento grande demais");
  if (!Array.isArray(blobIds) || blobIds.length > 20000) fail(400, "Lista de arquivos inválida");
  const existing = await c.env.DB.prepare("SELECT from_user FROM shares WHERE id = ?").bind(id).first<{ from_user: string }>();
  if (existing && existing.from_user !== me) fail(403, "Compartilhamento de outra pessoa");
  const target = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(toUser).first();
  if (!target) fail(404, "Destinatário não existe");
  // Só libera blobs que realmente pertencem a quem compartilha.
  const owned = new Set<string>();
  for (let i = 0; i < blobIds.length; i += 90) {
    const slice = blobIds.slice(i, i + 90).map(checkId);
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM blobs WHERE owner = ? AND id IN (${slice.map(() => "?").join(",")})`,
    )
      .bind(me, ...slice)
      .all<{ id: string }>();
    results.forEach((r) => owned.add(r.id));
  }
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO shares (id, from_user, to_user, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (id) DO UPDATE SET to_user = excluded.to_user, payload = excluded.payload, updated_at = excluded.updated_at`,
    ).bind(id, me, toUser, payload, now),
    c.env.DB.prepare("DELETE FROM share_blobs WHERE share_id = ?").bind(id),
    ...[...owned].map((b) => c.env.DB.prepare("INSERT INTO share_blobs (share_id, owner, blob_id) VALUES (?, ?, ?)").bind(id, me, b)),
  ];
  for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
  return c.json({ ok: true });
});

app.delete("/shares/:id", async (c) => {
  const id = checkId(c.req.param("id"));
  const me = c.get("userId");
  const row = await c.env.DB.prepare("SELECT from_user, to_user FROM shares WHERE id = ?").bind(id).first<{ from_user: string; to_user: string }>();
  if (!row) return c.json({ ok: true });
  if (row.from_user !== me && row.to_user !== me) fail(403, "Sem permissão");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM share_blobs WHERE share_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tidyCatalog(env));
  },
} satisfies ExportedHandler<Env>;
