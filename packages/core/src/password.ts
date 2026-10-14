import { argon2id } from "hash-wasm";
import { sha256, toB64, utf8 } from "./bytes";
import { importAesKey } from "./crypto";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deriva da senha (Argon2id, no aparelho):
 * - authKey: enviada ao servidor para login (o servidor guarda só um hash dela);
 * - kek: abre a chave mestra. Nunca sai do aparelho.
 */
export async function deriveFromPassword(email: string, password: string): Promise<{ authKey: string; kek: CryptoKey }> {
  const salt = (await sha256(`yfitops/v1/${normalizeEmail(email)}`)).subarray(0, 16);
  const out = await argon2id({
    password: utf8.encode(password),
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 64 * 1024, // 64 MiB
    hashLength: 64,
    outputType: "binary",
  });
  return { authKey: toB64(out.subarray(0, 32)), kek: await importAesKey(out.subarray(32, 64)) };
}
