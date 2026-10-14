import { decryptFile, encryptContent, type BlobRef, type Track, type Variant } from "@yfitops/core";
import { api, ApiError } from "./api";
import { db } from "./db";
import { createStore } from "./observable";
import { getKeys, getSession } from "./session";

const SINGLE_LIMIT = 80 * 1024 * 1024;
const PART_SIZE = 50 * 1024 * 1024;

// ---------------- Upload ----------------

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
  if (ref.owner && ref.owner !== getSession().userId) return;
  try {
    await api.raw(`/blobs/${ref.id}`, { method: "DELETE" });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  await (await db()).delete("files", fileKey(ref));
}

// ---------------- Download e cache offline ----------------

const fileKey = (ref: BlobRef) => `${ref.owner ?? getSession().userId}/${ref.id}`;
const ownerQuery = (ref: BlobRef) => (ref.owner && ref.owner !== getSession().userId ? `?owner=${ref.owner}` : "");

/** Chaves dos arquivos guardados offline (para a UI mostrar o que está baixado). */
export const offlineStore = createStore<Set<string>>(new Set());

export async function loadOfflineIndex() {
  offlineStore.set(new Set(await (await db()).getAllKeys("files")));
}

export const isOffline = (set: Set<string>, ref: BlobRef | undefined) => Boolean(ref && set.has(fileKey(ref)));

async function fetchSealed(ref: BlobRef, keep: boolean): Promise<Uint8Array> {
  const d = await db();
  const cached = await d.get("files", fileKey(ref));
  if (cached) return new Uint8Array(await cached.data.arrayBuffer());
  const sealed = await api.bytes(`/blobs/${ref.id}${ownerQuery(ref)}`);
  if (keep) {
    await d.put("files", { key: fileKey(ref), data: new Blob([sealed]), size: sealed.length, at: Date.now() });
    offlineStore.set((s) => new Set(s).add(fileKey(ref)));
  }
  return sealed;
}

export async function readBlob(ref: BlobRef, keep = false): Promise<Uint8Array> {
  return decryptFile(ref, await fetchSealed(ref, keep));
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
  const order: Variant[] = forceLight ? ["opus", "orig", "flac"] : ["flac", "orig", "opus"];
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
  return playableOrder(t, q === "max" ? ["flac", "orig", "opus"] : ["opus", "orig", "flac"])[0];
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
