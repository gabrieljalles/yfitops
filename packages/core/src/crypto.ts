import { concat, fromB64, fromUtf8, randomBytes, toB64, toHex, utf8 } from "./bytes";

const subtle = crypto.subtle;
const IV_LEN = 12;

/** Chaves derivadas da chave mestra de um usuário. Nunca saem do aparelho. */
export interface UserKeys {
  /** Criptografa metadados (itens) e a chave privada de compartilhamento. */
  enc: CryptoKey;
  /** HMAC para IDs estilo "magnet" — deduplica sem revelar o conteúdo. */
  dedup: CryptoKey;
}

export function newMasterKey(): Uint8Array {
  return randomBytes(32);
}

export async function deriveUserKeys(masterKey: Uint8Array): Promise<UserKeys> {
  const base = await subtle.importKey("raw", masterKey, "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(info) });
  const enc = await subtle.deriveKey(hkdf("yfitops/enc/v1"), base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const dedup = await subtle.deriveKey(hkdf("yfitops/dedup/v1"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [
    "sign",
  ]);
  return { enc, dedup };
}

export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return subtle.importKey("raw", raw, "AES-GCM", extractable, ["encrypt", "decrypt"]);
}

/** AES-GCM genérico: retorna iv || ciphertext. */
export async function seal(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(IV_LEN);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, key, plaintext);
  return concat(iv, new Uint8Array(ct));
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const iv = sealed.subarray(0, IV_LEN);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) },
    key,
    sealed.subarray(IV_LEN),
  );
  return new Uint8Array(pt);
}

/** Criptografa um objeto JSON amarrado ao seu ID (impede trocar blobs de lugar). */
export async function sealJSON(key: CryptoKey, id: string, value: unknown): Promise<string> {
  return toB64(await seal(key, utf8.encode(JSON.stringify(value)), utf8.encode(id)));
}

export async function openJSON<T>(key: CryptoKey, id: string, sealed: string): Promise<T> {
  return JSON.parse(fromUtf8.decode(await open(key, fromB64(sealed), utf8.encode(id)))) as T;
}

/** ID "magnet" privado: HMAC do conteúdo com a chave do usuário. */
export async function contentId(keys: UserKeys, data: Uint8Array): Promise<string> {
  return toHex(await subtle.sign("HMAC", keys.dedup, data)).slice(0, 40);
}

/**
 * Chave e IV do arquivo derivados do ID de conteúdo (criptografia convergente dentro da conta).
 * O mesmo conteúdo sempre gera o mesmo cifrado, então reenviar um arquivo repetido
 * (ex.: a mesma capa em várias faixas) nunca invalida a chave guardada nas outras.
 * O servidor conhece o ID, mas sem a chave dedup do usuário não consegue derivar nada.
 */
export async function deriveFileKey(keys: UserKeys, id: string): Promise<{ raw: Uint8Array; prefix: Uint8Array }> {
  const mac = async (label: string) => new Uint8Array(await subtle.sign("HMAC", keys.dedup, utf8.encode(`yfitops/${label}/v1/${id}`)));
  return { raw: await mac("file-key"), prefix: (await mac("file-iv")).subarray(0, 8) };
}

/** Cifra um arquivo de forma determinística e devolve também seu ID de conteúdo. */
export async function encryptContent(keys: UserKeys, data: Uint8Array): Promise<{ id: string; fileKey: FileKey; sealed: Uint8Array }> {
  const id = await contentId(keys, data);
  return { id, ...(await encryptFile(data, await deriveFileKey(keys, id))) };
}

// ---------- Criptografia assimétrica (escrow e compartilhamento) ----------
// ECIES com P-256: suportado por WebCrypto em todos os navegadores e no Workers.

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: Uint8Array }> {
  const kp = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    publicKey: toB64((await subtle.exportKey("spki", kp.publicKey)) as ArrayBuffer),
    privateKey: new Uint8Array((await subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer),
  };
}

export async function importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
}

async function eciesKey(priv: CryptoKey, pub: CryptoKey, info: Uint8Array): Promise<CryptoKey> {
  // Cast: os tipos do Workers chamam o campo de "$public", mas o runtime aceita "public".
  const params = { name: "ECDH", public: pub } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
  const bits = await subtle.deriveBits(params, priv, 256);
  const base = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Criptografa para a chave pública (spki, base64url) de alguém. */
export async function eciesSeal(recipientSpki: string, plaintext: Uint8Array): Promise<string> {
  const pub = await subtle.importKey("spki", fromB64(recipientSpki), ECDH, false, []);
  const eph = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const ephRaw = new Uint8Array((await subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer); // 65 bytes
  const key = await eciesKey(eph.privateKey, pub, utf8.encode("yfitops/ecies/v1"));
  return toB64(concat(ephRaw, await seal(key, plaintext, ephRaw)));
}

export async function eciesOpen(privateKey: CryptoKey, sealed: string): Promise<Uint8Array> {
  const bytes = fromB64(sealed);
  const ephRaw = bytes.subarray(0, 65);
  const pub = await subtle.importKey("raw", ephRaw, ECDH, false, []);
  const key = await eciesKey(privateKey, pub, utf8.encode("yfitops/ecies/v1"));
  return open(key, bytes.subarray(65), ephRaw);
}

// ---------- Arquivos em blocos ----------
// Cada bloco de 256 KiB é cifrado separadamente (AES-GCM), permitindo
// streaming e seek por Range. IV = prefixo aleatório (8 bytes) || índice (4 bytes).
// O AAD marca o último bloco, impedindo truncamento silencioso.

export const CHUNK_SIZE = 256 * 1024;
export const TAG_SIZE = 16;
export const SEALED_CHUNK_SIZE = CHUNK_SIZE + TAG_SIZE;

export interface FileKey {
  /** Chave AES-256 do arquivo (base64url). */
  key: string;
  /** Prefixo de IV (base64url, 8 bytes). */
  iv: string;
}

function chunkIv(prefix: Uint8Array, index: number): Uint8Array {
  const iv = new Uint8Array(IV_LEN);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

const LAST = new Uint8Array([1]);
const NOT_LAST = new Uint8Array([0]);

export function chunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
}

export function sealedSize(plainSize: number): number {
  return plainSize + chunkCount(plainSize) * TAG_SIZE;
}

/**
 * Cifra um arquivo. Sem `material`, usa chave e IV aleatórios.
 * Com `material` (de deriveFileKey), o resultado é determinístico: o mesmo conteúdo gera o mesmo cifrado.
 */
export async function encryptFile(
  data: Uint8Array,
  material?: { raw: Uint8Array; prefix: Uint8Array },
): Promise<{ fileKey: FileKey; sealed: Uint8Array }> {
  const raw = material?.raw ?? randomBytes(32);
  const prefix = material?.prefix ?? randomBytes(8);
  const key = await importAesKey(raw);
  const n = chunkCount(data.length);
  const out = new Uint8Array(sealedSize(data.length));
  for (let i = 0; i < n; i++) {
    const chunk = data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const ct = await subtle.encrypt(
      { name: "AES-GCM", iv: chunkIv(prefix, i), additionalData: i === n - 1 ? LAST : NOT_LAST },
      key,
      chunk,
    );
    out.set(new Uint8Array(ct), i * SEALED_CHUNK_SIZE);
  }
  return { fileKey: { key: toB64(raw), iv: toB64(prefix) }, sealed: out };
}

export async function decryptChunk(
  key: CryptoKey,
  prefix: Uint8Array,
  index: number,
  isLast: boolean,
  sealedChunk: Uint8Array,
): Promise<Uint8Array> {
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: chunkIv(prefix, index), additionalData: isLast ? LAST : NOT_LAST },
    key,
    sealedChunk,
  );
  return new Uint8Array(pt);
}

export async function decryptFile(fileKey: FileKey, sealed: Uint8Array): Promise<Uint8Array> {
  const key = await importAesKey(fromB64(fileKey.key));
  const prefix = fromB64(fileKey.iv);
  const n = Math.max(1, Math.ceil(sealed.length / SEALED_CHUNK_SIZE));
  const out = new Uint8Array(sealed.length - n * TAG_SIZE);
  for (let i = 0; i < n; i++) {
    const chunk = sealed.subarray(i * SEALED_CHUNK_SIZE, (i + 1) * SEALED_CHUNK_SIZE);
    out.set(await decryptChunk(key, prefix, i, i === n - 1, chunk), i * CHUNK_SIZE);
  }
  return out;
}
