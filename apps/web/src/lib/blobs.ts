import { decryptFile, encryptContent, type BlobRef, type Track, type Variant } from "@yfitops/core";
import { api, ApiError } from "./api";
import { db } from "./db";
import { createStore } from "./observable";
import { prefsStore } from "./prefs";
import { getKeys, getSession } from "./session";

const SINGLE_LIMIT = 80 * 1024 * 1024;
const PART_SIZE = 50 * 1024 * 1024;

// ---------------- Upload ----------------
// (Arquivos criptografados, só do dono: capas trocadas à mão. Músicas novas vão
// para o catálogo compartilhado, em catalog.ts.)

/** Criptografa e envia um arquivo. Se o mesmo conteúdo já existe na sua conta, não reenvia. */
export async function uploadBlob(
  plain: Uint8Array,
  mime: string,
  onProgress?: (fraction: number) => void,
): Promise<BlobRef> {
  // Determinístico: conteúdo repetido gera o mesmo cifrado, então reenviar é inofensivo.
  const { id, fileKey, sealed } = await encryptContent(getKeys(), plain);
  const ref: BlobRef = { id, ...fileKey, size: plain.length, mime };

  if (sealed.length <= SINGLE_LIMIT) {
    await api.raw(`/blobs/${id}`, { method: "PUT", body: sealed });
  } else {
    const { uploadId } = await api.json<{ uploadId: string }>(`/blobs/${id}/mpu`, {
      method: "POST",
      json: { size: sealed.length },
    });
    const parts: unknown[] = [];
    for (let n = 1, off = 0; off < sealed.length; n++, off += PART_SIZE) {
      parts.push(
        await api.json(`/blobs/${id}/mpu/${uploadId}/${n}`, { method: "PUT", body: sealed.subarray(off, off + PART_SIZE) }),
      );
      onProgress?.(Math.min(1, (off + PART_SIZE) / sealed.length));
    }
    await api.json(`/blobs/${id}/mpu/${uploadId}/complete`, { method: "POST", json: { parts } });
  }
  onProgress?.(1);
  return ref;
}

export async function deleteBlob(ref: BlobRef) {
  // Música do catálogo é de todos: sair da biblioteca não apaga da nuvem.
  if (ref.shared) return;
  if (ref.owner && ref.owner !== getSession().userId) return;
  try {
    await api.raw(`/blobs/${ref.id}`, { method: "DELETE" });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  await (await db()).delete("files", fileKey(ref));
}

// ---------------- Download e cache offline ----------------

const fileKey = (ref: BlobRef) => (ref.shared ? `songs/${ref.id}/${ref.shared}` : `${ref.owner ?? getSession().userId}/${ref.id}`);
const ownerQuery = (ref: BlobRef) => (!ref.shared && ref.owner && ref.owner !== getSession().userId ? `?owner=${ref.owner}` : "");
/** Caminho na API: catálogo (aberto) ou arquivo criptografado. */
const pathOf = (ref: BlobRef) => (ref.shared ? `/songs/${ref.id}/${ref.shared}` : `/blobs/${ref.id}${ownerQuery(ref)}`);

/** Chaves dos arquivos guardados offline (para a UI mostrar o que está baixado). */
export const offlineStore = createStore<Set<string>>(new Set());

export async function loadOfflineIndex() {
  offlineStore.set(new Set(await (await db()).getAllKeys("files")));
}

export const isOffline = (set: Set<string>, ref: BlobRef | undefined) => Boolean(ref && set.has(fileKey(ref)));

/**
 * Pega o arquivo, pedindo ao servidor no máximo UMA vez por aparelho:
 * 1. baixado para offline → do aparelho;
 * 2. já ouvido antes (cache) → do aparelho;
 * 3. senão, uma requisição só (o arquivo inteiro), que vai para o cache.
 * `keep`: guardar como download offline (sai do cache, não é apagado sozinho).
 */
async function fetchSealed(ref: BlobRef, keep: boolean): Promise<Uint8Array> {
  const d = await db();
  const key = fileKey(ref);
  const saved = await d.get("files", key);
  if (saved) return new Uint8Array(await saved.data.arrayBuffer());

  const hit = await d.get("cache", key);
  let sealed: Uint8Array;
  if (hit) {
    sealed = new Uint8Array(await hit.data.arrayBuffer());
    if (!keep) await d.put("cache", { ...hit, at: Date.now() }); // tocou de novo: fica mais tempo
  } else {
    sealed = await api.bytes(pathOf(ref));
  }
  if (keep) {
    await d.put("files", { key, data: new Blob([sealed]), size: sealed.length, at: Date.now() });
    if (hit) await d.delete("cache", key);
    offlineStore.set((s) => new Set(s).add(key));
  } else if (!hit) {
    await d.put("cache", { key, data: new Blob([sealed]), size: sealed.length, at: Date.now() });
    void trimCache();
  }
  return sealed;
}

/** Guarda no cache um arquivo que este aparelho já tem (ex.: acabou de enviar): tocar não baixa de volta. */
export async function rememberLocal(ref: BlobRef, data: Uint8Array) {
  await (await db()).put("cache", { key: fileKey(ref), data: new Blob([data]), size: data.length, at: Date.now() });
  void trimCache();
}

/** Tira do cache as músicas ouvidas há mais tempo até caber no limite (Ajustes). */
async function trimCache() {
  const limit = prefsStore.get().cacheMB * 1024 * 1024;
  const d = await db();
  const all = (await d.getAll("cache")).sort((a, b) => a.at - b.at);
  let total = all.reduce((n, f) => n + f.size, 0);
  for (const f of all) {
    if (total <= limit) break;
    await d.delete("cache", f.key);
    total -= f.size;
  }
}

/** Espaço das músicas já ouvidas guardadas no aparelho. */
export async function cacheUsage(): Promise<number> {
  return (await (await db()).getAll("cache")).reduce((n, f) => n + f.size, 0);
}

export async function clearCache() {
  await (await db()).clear("cache");
}

/** Já está no aparelho (baixada ou no cache)? Aí tocar não custa nada. */
export async function isLocal(ref: BlobRef): Promise<boolean> {
  const d = await db();
  return Boolean((await d.getKey("files", fileKey(ref))) ?? (await d.getKey("cache", fileKey(ref))));
}

export async function readBlob(ref: BlobRef, keep = false): Promise<Uint8Array> {
  const data = await fetchSealed(ref, keep);
  return ref.shared ? data : decryptFile(ref, data);
}

export async function saveOffline(ref: BlobRef) {
  await fetchSealed(ref, true);
}

export async function removeOffline(ref: BlobRef) {
  await (await db()).delete("files", fileKey(ref));
  offlineStore.set((s) => {
    const n = new Set(s);
    n.delete(fileKey(ref));
    return n;
  });
}

export async function offlineUsage(): Promise<number> {
  const all = await (await db()).getAll("files");
  return all.reduce((n, f) => n + f.size, 0);
}

export async function clearOffline() {
  await (await db()).clear("files");
  offlineStore.set(new Set());
}

// ---------------- Escolha de qualidade ----------------

export type Quality = "auto" | "high" | "light";

export function getQuality(): Quality {
  return (localStorage.getItem("quality") as Quality) || "auto";
}

export function setQuality(q: Quality) {
  localStorage.setItem("quality", q);
}

function wantsLight(): boolean {
  const q = getQuality();
  if (q !== "auto") return q === "light";
  const conn = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return Boolean(conn?.saveData || conn?.type === "cellular");
}

const probe = typeof Audio !== "undefined" ? new Audio() : null;
const playCache = new Map<string, boolean>();

/** Se este navegador toca o formato (ex.: WMA e AC3 originais não tocam; aí usa a versão leve). */
export function canPlay(mime: string): boolean {
  let ok = playCache.get(mime);
  if (ok === undefined) {
    ok = !probe || probe.canPlayType(mime) !== "" || probe.canPlayType(mime.split(";")[0]) !== "";
    playCache.set(mime, ok);
  }
  return ok;
}

/** Variantes tocáveis na ordem de preferência; se nenhuma tocar, devolve todas (melhor tentar que nada). */
function playableOrder(t: Track, order: Variant[]): BlobRef[] {
  const refs = order.map((v) => t.variants[v]).filter(Boolean) as BlobRef[];
  const playable = refs.filter((r) => canPlay(r.mime));
  return playable.length ? playable : refs;
}

/**
 * Todas as variantes, na ordem em que o player deve tentar: as que o navegador diz tocar primeiro,
 * as já baixadas antes das outras, e por fim as "não tocáveis" (o canPlayType às vezes erra).
 */
export function variantCandidates(t: Track, offline: Set<string>, forceLight = wantsLight()): BlobRef[] {
  const order: Variant[] = forceLight ? ["mp3", "opus", "orig", "flac"] : ["mp3", "flac", "orig", "opus"];
  const refs = order.map((v) => t.variants[v]).filter(Boolean) as BlobRef[];
  const rank = (r: BlobRef) => (canPlay(r.mime) ? 0 : 2) + (isOffline(offline, r) ? 0 : 1);
  return refs.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
}

/** Variante a tocar: prefere o que já está offline; senão segue a configuração de qualidade. */
export function pickVariant(t: Track, offline: Set<string>, forceLight = wantsLight()): BlobRef {
  return variantCandidates(t, offline, forceLight)[0];
}

/** normal = Opus 160 kbps (leve) · max = FLAC sem perda. Músicas que já chegaram com perda só têm o original. */
export type DownloadQuality = "normal" | "max";

export function defaultDownloadQuality(): DownloadQuality {
  return localStorage.getItem("offlineQuality") === "high" ? "max" : "normal";
}

export function setDefaultDownloadQuality(q: DownloadQuality) {
  localStorage.setItem("offlineQuality", q === "max" ? "high" : "light");
}

/** Variante a baixar para offline na qualidade pedida. */
export function offlineVariant(t: Track, q: DownloadQuality = defaultDownloadQuality()): BlobRef {
  return playableOrder(t, q === "max" ? ["mp3", "flac", "orig", "opus"] : ["mp3", "opus", "orig", "flac"])[0];
}

/** Se a música tem versões diferentes para "normal" e "máxima". */
export function hasQualityChoice(t: Track): boolean {
  return offlineVariant(t, "normal").id !== offlineVariant(t, "max").id;
}

/** Qualidade já baixada neste aparelho ("original" quando só existe uma versão). */
export function downloadedQuality(t: Track, offline: Set<string>): DownloadQuality | "original" | null {
  if (!hasQualityChoice(t)) return isOffline(offline, offlineVariant(t)) ? "original" : null;
  if (isOffline(offline, offlineVariant(t, "max"))) return "max";
  if (isOffline(offline, offlineVariant(t, "normal"))) return "normal";
  return null;
}

// ---------------- URLs decifradas ----------------

const coverUrls = new Map<string, Promise<string>>();

/** Capas são pequenas: ficam sempre guardadas no aparelho. */
export function coverUrl(ref: BlobRef): Promise<string> {
  let p = coverUrls.get(ref.id);
  if (!p) {
    p = readBlob(ref, true).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: ref.mime })));
    p.catch(() => coverUrls.delete(ref.id));
    coverUrls.set(ref.id, p);
  }
  return p;
}
