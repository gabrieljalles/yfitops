import { sha256, toB64, type SharedRef, type SongInfo, type SongQuery, type Track } from "@yfitops/core";
import { api } from "./api";
import { removeOffline } from "./blobs";
import { deleteItem, libraryStore, saveItem } from "./library";
import { mergeTags } from "./search";
import { deleteTracks } from "./tracks";

// ---------------------------------------------------------------------------
// Catálogo compartilhado: cada música existe uma vez só na nuvem (MP3, sem
// criptografia), e a biblioteca de cada pessoa aponta para ela.
//
// Antes de converter, enviar ou baixar do YouTube, o app pergunta ao servidor se
// a música já existe (mesma origem, mesmo arquivo, ou mesmo artista/título com
// duração parecida). Se existe, só liga na biblioteca: nada é enviado.
// ---------------------------------------------------------------------------

const SINGLE_LIMIT = 80 * 1024 * 1024;
const PART_SIZE = 50 * 1024 * 1024;

/** Id da faixa na biblioteca para uma música do catálogo (a mesma música não entra duas vezes). */
export const songTrackId = (songId: string) => `song.${songId}`;

export const audioRef = (s: SongInfo): SharedRef => ({ id: s.id, shared: "audio", size: s.size, mime: "audio/mpeg" });
export const coverRef = (s: SongInfo): SharedRef | undefined =>
  s.coverSize ? { id: s.id, shared: "cover", size: s.coverSize, mime: "image/webp" } : undefined;

/** SHA-256 do arquivo original: o mesmo arquivo enviado por outra pessoa é achado na hora. */
export const fileHash = async (bytes: Uint8Array) => toB64(await sha256(bytes));

/** A música já está no catálogo? */
export async function findInCatalog(q: SongQuery): Promise<SongInfo | null> {
  return (await api.json<{ song: SongInfo | null }>("/songs/match", { method: "POST", json: q })).song;
}

/** Procura no catálogo (músicas que qualquer pessoa enviou). */
export async function searchCatalog(text: string): Promise<SongInfo[]> {
  return (await api.json<{ songs: SongInfo[] }>(`/songs/search?q=${encodeURIComponent(text)}`)).songs;
}

/**
 * Envia uma música nova ao catálogo. Se alguém enviou a mesma enquanto este
 * aparelho convertia, o servidor devolve a existente e nada é enviado.
 */
export async function publishSong(
  audio: Uint8Array,
  cover: Uint8Array | undefined,
  q: SongQuery & { album: string },
  onProgress?: (fraction: number) => void,
): Promise<{ song: SongInfo; created: boolean }> {
  const res = await api.json<{ song: SongInfo; created: boolean }>("/songs", {
    method: "POST",
    json: { ...q, size: audio.length, coverSize: cover?.length ?? 0 },
  });
  if (!res.created) return res;
  const id = res.song.id;
  if (audio.length <= SINGLE_LIMIT) {
    await api.raw(`/songs/${id}/audio`, { method: "PUT", body: audio });
  } else {
    const { uploadId } = await api.json<{ uploadId: string }>(`/songs/${id}/mpu`, { method: "POST" });
    const parts: unknown[] = [];
    for (let n = 1, off = 0; off < audio.length; n++, off += PART_SIZE) {
      parts.push(await api.json(`/songs/${id}/mpu/${uploadId}/${n}`, { method: "PUT", body: audio.subarray(off, off + PART_SIZE) }));
      onProgress?.(Math.min(1, (off + PART_SIZE) / audio.length));
    }
    await api.json(`/songs/${id}/mpu/${uploadId}/complete`, { method: "POST", json: { parts } });
  }
  if (cover) await api.raw(`/songs/${id}/cover`, { method: "PUT", body: cover });
  await api.json(`/songs/${id}/done`, { method: "POST" });
  onProgress?.(1);
  return res;
}

/** O que a pessoa traz junto ao adicionar uma música (além do que o catálogo já sabe). */
export interface SongExtras {
  tags?: string[];
  /** Origem ("youtube:<id>"): a mesma faixa não é baixada de novo. */
  source?: string;
  /** Origens no Spotify/Deezer, para sincronizar playlists sem buscar no YouTube. */
  alsoFrom?: string[];
  genre?: string;
  year?: number;
  /** Informação do arquivo enviado (ex.: "FLAC · 24-bit"). */
  sourceInfo?: string;
}

/**
 * Põe uma música do catálogo na biblioteca. Se já estava, só recebe as tags e
 * as origens novas. Devolve o id da faixa e se ela já estava.
 */
export async function addSong(song: SongInfo, extras: SongExtras = {}): Promise<{ id: string; existed: boolean }> {
  const id = songTrackId(song.id);
  const existing = libraryStore.get().tracks[id];
  if (existing) {
    const tags = mergeTags(existing.tags, extras.tags);
    const newOrigins = (extras.alsoFrom ?? []).filter((k) => !existing.alsoFrom?.includes(k));
    const alsoFrom = newOrigins.length ? [...(existing.alsoFrom ?? []), ...newOrigins] : existing.alsoFrom;
    const source = !existing.source ? extras.source : undefined;
    if (tags !== existing.tags || alsoFrom !== existing.alsoFrom || source) {
      await saveItem("track", id, { ...existing, tags, ...(alsoFrom && { alsoFrom }), ...(source && { source }) });
    }
    return { id, existed: true };
  }
  const cover = coverRef(song);
  const track: Track = {
    title: song.title,
    artist: song.artist,
    album: song.album,
    genre: extras.genre ?? "",
    ...(extras.year && { year: extras.year }),
    tags: mergeTags([], extras.tags),
    duration: song.duration,
    sourceInfo: extras.sourceInfo || "MP3",
    variants: { mp3: audioRef(song) },
    ...(cover && { cover }),
    song: song.id,
    ...(extras.source && { source: extras.source }),
    ...(extras.alsoFrom?.length && { alsoFrom: extras.alsoFrom }),
    addedAt: Date.now(),
  };
  await saveItem("track", id, track);
  return { id, existed: false };
}

// ---------------- Duplicadas juntadas pela faxina do servidor ----------------

// A faxina do servidor roda 1x por dia: conferir a cada 6 h basta.
const RECONCILE_EVERY = 6 * 60 * 60 * 1000;
let lastReconcile = 0;

/**
 * A faxina diária do servidor junta músicas duplicadas do catálogo. Aqui a
 * biblioteca acompanha: a faixa passa a apontar para a música que ficou, e se a
 * pessoa tinha as duas, vira uma só (favorita, tags e playlists preservadas).
 * Músicas que o administrador apagou do sistema saem da biblioteca.
 */
export async function reconcileMerges(force = false) {
  if (!force && Date.now() - lastReconcile < RECONCILE_EVERY) return;
  // Só com a biblioteca em dia: uma lista incompleta (sync que falhou, aparelho
  // recém-logado) faria o servidor achar que a pessoa não tem mais essas músicas.
  const lib = libraryStore.get();
  if (!lib.lastSync || lib.error || lib.offline) return;
  lastReconcile = Date.now();
  const tracks = lib.tracks;
  // Vai mesmo vazia: a lista também diz ao servidor quais músicas esta conta tem
  // (as bibliotecas são criptografadas). Música que ninguém tem sai na faxina.
  const ids = [...new Set(Object.values(tracks).flatMap((t) => (t.song ? [t.song] : [])))];
  const { merged, removed } = await api.json<{ merged: Record<string, SongInfo>; removed: string[] }>("/songs/resolve", {
    method: "POST",
    json: { ids },
  });
  const gone = Object.entries(tracks).filter(([, t]) => t.song && removed.includes(t.song));
  if (gone.length) {
    await deleteTracks(gone.map(([id]) => id));
    for (const [, t] of gone) for (const r of [t.variants.mp3, t.cover]) if (r?.shared) await removeOffline(r).catch(() => {});
  }
  for (const [oldId, t] of Object.entries(tracks)) {
    const song = t.song ? merged[t.song] : undefined;
    if (!song) continue;
    const newId = songTrackId(song.id);
    const current = libraryStore.get().tracks;
    const keep = current[newId];
    if (keep) {
      await saveItem("track", newId, {
        ...keep,
        tags: mergeTags(keep.tags, t.tags),
        ...((keep.favoriteAt || t.favoriteAt) && { favoriteAt: keep.favoriteAt ?? t.favoriteAt }),
        alsoFrom: [...new Set([...(keep.alsoFrom ?? []), ...(t.alsoFrom ?? [])])],
        addedAt: Math.min(keep.addedAt, t.addedAt),
      });
    } else {
      const cover = t.cover?.shared ? coverRef(song) : t.cover;
      await saveItem("track", newId, { ...t, song: song.id, variants: { mp3: audioRef(song) }, cover });
    }
    for (const [pid, p] of Object.entries(libraryStore.get().playlists)) {
      if (!p.trackIds.includes(oldId)) continue;
      const trackIds = [...new Set(p.trackIds.map((x) => (x === oldId ? newId : x)))];
      await saveItem("playlist", pid, { ...p, trackIds });
    }
    await deleteItem("track", oldId);
    for (const r of [t.variants.mp3, t.cover]) if (r?.shared) await removeOffline(r).catch(() => {});
  }
}
