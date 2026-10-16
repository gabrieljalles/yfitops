import {
  deriveUserKeys,
  eciesSeal,
  fromB64,
  generateKeyPair,
  importPrivateKey,
  newMasterKey,
  open,
  seal,
  toB64,
  type AccountBilling,
  type AccountInfo,
  type AccountStatus,
  type SessionResponse,
  type UserKeys,
} from "@yfitops/core";
import { deriveFromPassword } from "@yfitops/core/password";
import { api, setPaymentRequiredHandler, setToken, setUnauthorizedHandler } from "./api";
import { kvGet, kvSet, wipe } from "./db";
import { createStore } from "./observable";

/**
 * Fica salva no aparelho junto com a cobrança (paidUntil), então o bloqueio por
 * pagamento vencido vale até sem internet, para as músicas baixadas também.
 */
export interface Session extends AccountBilling {
  token: string;
  userId: string;
  email: string;
  publicKey: string;
  /** Ausente nas sessões salvas antes da aprovação existir: conta como liberada. */
  status?: AccountStatus;
  admin?: true;
}

/** Pedidos de acesso esperando (só o administrador recebe). */
export const pendingRequestsStore = createStore(0);

export interface Keys extends UserKeys {
  /** Chave privada de compartilhamento (não-extraível). */
  privateKey: CryptoKey;
}

/** undefined = carregando; null = deslogado. */
export const sessionStore = createStore<Session | null | undefined>(undefined);
let keys: Keys | null = null;

export function getKeys(): Keys {
  if (!keys) throw new Error("Sem sessão");
  return keys;
}

export function getSession(): Session {
  const s = sessionStore.get();
  if (!s) throw new Error("Sem sessão");
  return s;
}

setUnauthorizedHandler(() => void logout());
// Pagamento vencido (402): pergunta a situação para mostrar a tela de pagamento.
setPaymentRequiredHandler(() => void refreshAccount());

/** Só os campos de cobrança (o servidor manda os que existem; os outros somem). */
const billingOf = (b: AccountBilling): AccountBilling => ({
  ...(b.paidUntil !== undefined && { paidUntil: b.paidUntil }),
  ...(b.phone !== undefined && { phone: b.phone }),
  ...(b.paymentInfo !== undefined && { paymentInfo: b.paymentInfo }),
  ...(b.catalog && { catalog: true as const }),
});

/** Acesso vencido? Administrador e sessões antigas (sem data) nunca vencem. */
export const isExpired = (s: Session | null | undefined, now = Date.now()) =>
  Boolean(s && s.status !== "pending" && s.paidUntil !== undefined && s.paidUntil < now);

/** Restaura a sessão salva neste aparelho (as CryptoKeys ficam no IndexedDB, não-extraíveis). */
export async function restoreSession() {
  const s = await kvGet<Session>("session");
  const k = await kvGet<Keys>("keys");
  if (s && k) {
    keys = k;
    setToken(s.token);
    sessionStore.set(s);
  } else {
    sessionStore.set(null);
  }
}

async function finishLogin(res: SessionResponse, masterKey: Uint8Array) {
  const user = await deriveUserKeys(masterKey);
  const pkcs8 = await open(user.enc, fromB64(res.wrappedPrivateKey));
  const k: Keys = { ...user, privateKey: await importPrivateKey(pkcs8) };
  const s: Session = {
    token: res.token,
    userId: res.userId,
    email: res.email,
    publicKey: res.publicKey,
    status: res.status,
    ...(res.admin && { admin: true as const }),
    ...billingOf(res),
  };
  const previous = await kvGet<Session>("session");
  if (previous && previous.userId !== s.userId) await wipe();
  await kvSet("keys", k);
  await kvSet("session", s);
  keys = k;
  setToken(s.token);
  sessionStore.set(s);
}

/**
 * Pergunta ao servidor a situação da conta: se foi aprovada (quem espera fica
 * perguntando) e, para o administrador, quantos pedidos de acesso esperam.
 */
export async function refreshAccount() {
  const s = sessionStore.get();
  if (!s) return;
  let info: AccountInfo;
  try {
    info = await api.json<AccountInfo>("/auth/me");
  } catch {
    return; // offline: fica como estava
  }
  pendingRequestsStore.set(info.pendingRequests ?? 0);
  const { admin: _old, paidUntil: _p, phone: _ph, paymentInfo: _pi, catalog: _c, ...rest } = s;
  const next: Session = { ...rest, status: info.status, ...(info.admin && { admin: true as const }), ...billingOf(info) };
  if (JSON.stringify(next) !== JSON.stringify(s)) {
    await kvSet("session", next);
    sessionStore.set(next);
  }
}

export interface SignupStart {
  /** false = sem código: a conta é criada direto e espera a aprovação. */
  codeRequired: boolean;
  mailed?: boolean;
  /** Para onde o código foi (pode ser outra caixa, mascarada). */
  sentTo?: string;
  /** Desenvolvimento sem e-mail configurado: o próprio código. */
  devCode?: string;
}

/** Etapa 1 do cadastro: o servidor diz se precisa de código e, se precisar, envia por e-mail. */
export async function startSignup(email: string): Promise<SignupStart> {
  return api.json("/auth/signup/start", { method: "POST", json: { email } });
}

/** O servidor manda códigos e links por e-mail para todos? (Senão, quem cuida do app manda o link.) */
export async function emailCodesEnabled(): Promise<boolean> {
  try {
    return (await api.json<{ emailCodes?: boolean }>("/auth/config")).emailCodes === true;
  } catch {
    return true;
  }
}

/** Etapa 2: cria a conta com o código recebido. */
export async function signup(email: string, password: string, code: string, phone: string) {
  const { escrowPublicKey } = await api.json<{ escrowPublicKey: string }>("/auth/config");
  const { authKey, kek } = await deriveFromPassword(email, password);
  const mk = newMasterKey();
  const user = await deriveUserKeys(mk);
  const kp = await generateKeyPair();
  const res = await api.json<SessionResponse>("/auth/signup", {
    method: "POST",
    json: {
      email,
      authKey,
      code,
      phone,
      wrappedMasterKey: toB64(await seal(kek, mk)),
      escrowMasterKey: await eciesSeal(escrowPublicKey, mk),
      publicKey: kp.publicKey,
      wrappedPrivateKey: toB64(await seal(user.enc, kp.privateKey)),
    },
  });
  await finishLogin(res, mk);
}

export async function login(email: string, password: string) {
  const { authKey, kek } = await deriveFromPassword(email, password);
  const res = await api.json<SessionResponse>("/auth/login", { method: "POST", json: { email, authKey } });
  await finishLogin(res, await open(kek, fromB64(res.wrappedMasterKey)));
}

export async function forgotPassword(email: string) {
  await api.json("/auth/forgot", { method: "POST", json: { email } });
}

export async function resetPassword(token: string, password: string) {
  const { email, masterKey } = await api.json<{ email: string; masterKey: string }>("/auth/reset/start", {
    method: "POST",
    json: { token },
  });
  const mk = fromB64(masterKey);
  const { authKey, kek } = await deriveFromPassword(email, password);
  const res = await api.json<SessionResponse>("/auth/reset/finish", {
    method: "POST",
    json: { token, authKey, wrappedMasterKey: toB64(await seal(kek, mk)) },
  });
  await finishLogin(res, mk);
}

export async function logout() {
  try {
    await api.json("/auth/logout", { method: "POST" });
  } catch {
    /* offline ou sessão já expirada */
  }
  keys = null;
  setToken(null);
  await wipe();
  sessionStore.set(null);
  location.hash = "#/";
}
