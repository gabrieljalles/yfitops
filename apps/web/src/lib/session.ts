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
  type SessionResponse,
  type UserKeys,
} from "@yfitops/core";
import { deriveFromPassword } from "@yfitops/core/password";
import { api, setToken, setUnauthorizedHandler } from "./api";
import { kvGet, kvSet, wipe } from "./db";
import { createStore } from "./observable";

export interface Session {
  token: string;
  userId: string;
  email: string;
  publicKey: string;
}

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
  const s: Session = { token: res.token, userId: res.userId, email: res.email, publicKey: res.publicKey };
  const previous = await kvGet<Session>("session");
  if (previous && previous.userId !== s.userId) await wipe();
  await kvSet("keys", k);
  await kvSet("session", s);
  keys = k;
  setToken(s.token);
  sessionStore.set(s);
}

/**
 * Etapa 1 do cadastro: pede ao servidor um código de 6 dígitos por e-mail.
 * Em desenvolvimento sem e-mail configurado, o servidor devolve o código (devCode).
 */
export async function startSignup(email: string): Promise<{ mailed: boolean; devCode?: string }> {
  return api.json("/auth/signup/start", { method: "POST", json: { email } });
}

/** Etapa 2: cria a conta com o código recebido. */
export async function signup(email: string, password: string, code: string) {
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
