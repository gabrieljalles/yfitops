/**
 * Teste ponta a ponta da API. Rode com o Worker local ativo:
 *   API_URL=http://127.0.0.1:8787 npx vitest run test/api.e2e.test.ts
 * (o Worker precisa de DEV_MODE=1 no .dev.vars, que devolve o código de cadastro na resposta)
 */
import { describe, expect, it } from "vitest";
import {
  decryptFile,
  deriveUserKeys,
  eciesOpen,
  eciesSeal,
  encryptFile,
  fromB64,
  generateKeyPair,
  importPrivateKey,
  newMasterKey,
  open,
  openJSON,
  randomBytes,
  seal,
  sealJSON,
  toB64,
  type SessionResponse,
  type SyncPullResponse,
} from "../src";
import { deriveFromPassword } from "../src/password";

declare const process: { env: Record<string, string | undefined> };
const API = process.env.API_URL;

async function call<T>(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  const res = await fetch(`${API}/api${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const type = res.headers.get("Content-Type") ?? "";
  return (type.includes("json") ? res.json() : new Uint8Array(await res.arrayBuffer())) as Promise<T>;
}

async function signup(email: string, password: string) {
  const { escrowPublicKey } = await call<{ escrowPublicKey: string }>("/auth/config");
  const { authKey, kek } = await deriveFromPassword(email, password);
  const mk = newMasterKey();
  const keys = await deriveUserKeys(mk);
  const kp = await generateKeyPair();
  const { devCode } = await call<{ devCode: string }>("/auth/signup/start", { method: "POST", json: { email } });
  const session = await call<SessionResponse>("/auth/signup", {
    method: "POST",
    json: {
      email,
      authKey,
      code: devCode,
      phone: "(11) 98765-4321",
      wrappedMasterKey: toB64(await seal(kek, mk)),
      escrowMasterKey: await eciesSeal(escrowPublicKey, mk),
      publicKey: kp.publicKey,
      wrappedPrivateKey: toB64(await seal(keys.enc, kp.privateKey)),
    },
  });
  return { session, mk, keys, kp };
}

describe.skipIf(!API)("API", () => {
  const email = `teste-${Date.now()}@exemplo.com`;

  it("código de cadastro errado é recusado", async () => {
    const e = `codigo-${Date.now()}@exemplo.com`;
    await call("/auth/signup/start", { method: "POST", json: { email: e } });
    await expect(
      call("/auth/signup", {
        method: "POST",
        json: { email: e, code: "000000", phone: "11987654321", authKey: "x", wrappedMasterKey: "x", escrowMasterKey: "x", publicKey: "x", wrappedPrivateKey: "x" },
      }),
    ).rejects.toThrow(/400|Código/);
    await expect(call("/auth/signup/start", { method: "POST", json: { email: e } })).rejects.toThrow(/429/);
  });

  it("fluxo completo: conta, sync, arquivo, login", async () => {
    const a = await signup(email, "senha-forte");
    const b = await signup(`b-${email}`, "outra-senha");

    // Sync de metadados
    const enc = await sealJSON(a.keys.enc, "t1", { title: "Música" });
    await call("/sync", { method: "POST", token: a.session.token, json: { items: [{ id: "t1", kind: "track", enc, deleted: false }] } });
    const pull = await call<SyncPullResponse>("/sync?since=0", { token: a.session.token });
    expect(pull.items).toHaveLength(1);
    expect(await openJSON(a.keys.enc, "t1", pull.items[0].enc!)).toEqual({ title: "Música" });
    const empty = await call<SyncPullResponse>(`/sync?since=${pull.cursor}`, { token: a.session.token });
    expect(empty.items).toHaveLength(0);

    // Arquivo criptografado + Range
    const data = randomBytes(600_000);
    const { fileKey, sealed } = await encryptFile(data);
    await call("/blobs/abc123", { method: "PUT", token: a.session.token, body: sealed });
    const back = await call<Uint8Array>("/blobs/abc123", { token: a.session.token });
    expect(await decryptFile(fileKey, back)).toEqual(data);
    const part = await fetch(`${API}/api/blobs/abc123`, { headers: { Authorization: `Bearer ${a.session.token}`, Range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(sealed.subarray(10, 20));

    // B não acessa o arquivo de A (não existe mais compartilhamento)
    await expect(call(`/blobs/abc123?owner=${a.session.userId}`, { token: b.session.token })).rejects.toThrow(/404/);
    await expect(call("/shares", { token: b.session.token })).rejects.toThrow(/404/);

    // Login abre a mesma chave mestra
    const { authKey, kek } = await deriveFromPassword(email, "senha-forte");
    const login = await call<SessionResponse>("/auth/login", { method: "POST", json: { email, authKey } });
    expect(await open(kek, fromB64(login.wrappedMasterKey))).toEqual(a.mk);
    await expect(call("/auth/login", { method: "POST", json: { email, authKey: toB64(randomBytes(32)) } })).rejects.toThrow(/401/);
  }, 60_000);
});
