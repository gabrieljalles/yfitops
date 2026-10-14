import type { BlobRef, Track } from "@yfitops/core";
import { defaultDownloadQuality, deleteBlob, offlineVariant, removeOffline, saveOffline, uploadBlob, type DownloadQuality } from "./blobs";
import { makeCover } from "./importer";
import { deleteItem, getTrack, libraryStore, saveItem } from "./library";

/**
 * Marca (ou desmarca) como favoritas. Só as da própria biblioteca: as recebidas
 * por compartilhamento são de outra pessoa.
 */
export async function setFavorite(ids: string[], on: boolean) {
  const tracks = libraryStore.get().tracks;
  for (const id of ids) {
    const t = tracks[id];
    if (!t || !!t.favoriteAt === on) continue;
    const { favoriteAt: _old, ...rest } = t;
    await saveItem("track", id, on ? { ...t, favoriteAt: Date.now() } : rest);
  }
}

/** Blobs ainda usados por outras faixas (ex.: a mesma capa num álbum inteiro). */
function inUse(exceptId: string): Set<string> {
  const ids = new Set<string>();
  for (const [id, t] of Object.entries(libraryStore.get().tracks)) {
    if (id === exceptId) continue;
    Object.values(t.variants).forEach((v) => v && ids.add(v.id));
    if (t.cover) ids.add(t.cover.id);
  }
  return ids;
}

export async function updateTrack(id: string, patch: Partial<Track>) {
  const t = libraryStore.get().tracks[id];
  if (t) await saveItem("track", id, { ...t, ...patch });
}

export async function deleteTrack(id: string) {
  const t = libraryStore.get().tracks[id];
  if (!t) return;
  const used = inUse(id);
  const refs = [...Object.values(t.variants), t.cover].filter(Boolean) as BlobRef[];
  await deleteItem("track", id);
  // Remove das playlists.
  for (const [pid, p] of Object.entries(libraryStore.get().playlists)) {
    if (p.trackIds.includes(id)) await saveItem("playlist", pid, { ...p, trackIds: p.trackIds.filter((x) => x !== id) });
  }
  for (const r of refs) if (!used.has(r.id)) await deleteBlob(r).catch(() => {});
}

/**
 * Exclui várias músicas de uma vez: tira das playlists (cada playlist é salva uma vez
 * só) e apaga da nuvem os arquivos que nenhuma faixa restante usa.
 */
export async function deleteTracks(ids: string[], onProgress?: (done: number, total: number) => void) {
  const gone = new Set(ids.filter((id) => libraryStore.get().tracks[id]));
  if (!gone.size) return;
  const before = libraryStore.get().tracks;
  const refs = [...gone].flatMap((id) => [...Object.values(before[id].variants), before[id].cover].filter(Boolean) as BlobRef[]);

  for (const [pid, p] of Object.entries(libraryStore.get().playlists)) {
    if (p.trackIds.some((x) => gone.has(x))) await saveItem("playlist", pid, { ...p, trackIds: p.trackIds.filter((x) => !gone.has(x)) });
  }
  let done = 0;
  for (const id of gone) {
    await deleteItem("track", id);
    onProgress?.(++done, gone.size);
  }
  // Blobs ainda usados por faixas que ficaram (ex.: a mesma capa num álbum).
  const used = inUse("");
  const seen = new Set<string>();
  for (const r of refs) {
    if (used.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    await deleteBlob(r).catch(() => {});
  }
}

export async function setCover(id: string, image: File) {
  const t = libraryStore.get().tracks[id];
  if (!t) return;
  const cover = await uploadBlob(await makeCover(image), "image/webp");
  const old = t.cover;
  await saveItem("track", id, { ...t, cover });
  if (old && old.id !== cover.id && !inUse(id).has(old.id)) await deleteBlob(old).catch(() => {});
}

export async function removeCover(id: string) {
  const t = libraryStore.get().tracks[id];
  if (!t?.cover) return;
  const old = t.cover;
  await saveItem("track", id, { ...t, cover: undefined });
  if (!inUse(id).has(old.id)) await deleteBlob(old).catch(() => {});
}

/** Baixa na qualidade escolhida; se outra qualidade já estava no aparelho, ela é trocada (libera espaço). */
export async function downloadTracks(
  ids: string[],
  quality: DownloadQuality = defaultDownloadQuality(),
  onProgress?: (done: number, total: number) => void,
) {
  let done = 0;
  for (const id of ids) {
    const t = getTrack(id);
    if (t) {
      const keep = offlineVariant(t, quality);
      await saveOffline(keep);
      for (const v of Object.values(t.variants)) if (v && v.id !== keep.id) await removeOffline(v);
      if (t.cover) await saveOffline(t.cover).catch(() => {});
    }
    onProgress?.(++done, ids.length);
  }
}

/** Tamanho total para baixar as músicas numa qualidade. */
export function downloadSize(ids: string[], quality: DownloadQuality): number {
  return ids.reduce((n, id) => {
    const t = getTrack(id);
    return n + (t ? offlineVariant(t, quality).size : 0);
  }, 0);
}

export async function removeDownloads(ids: string[]) {
  for (const id of ids) {
    const t = getTrack(id);
    if (t) for (const v of Object.values(t.variants)) if (v) await removeOffline(v);
  }
}

export function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export const musicas = (n: number) => `${n} ${n === 1 ? "música" : "músicas"}`;
