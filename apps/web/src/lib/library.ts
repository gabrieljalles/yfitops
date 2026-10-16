import {
  eciesOpen,
  eciesSeal,
  fromUtf8,
  openJSON,
  randomId,
  sealJSON,
  utf8,
  type ItemKind,
  type ItemValue,
  type Play,
  type Playlist,
  type ShareInfo,
  type SharePayload,
  type SyncPullResponse,
  type Track,
} from "@yfitops/core";
import { api, ApiError } from "./api";
import { dropLocal, keepLocal } from "./blobs";
import { db, kvGet, kvSet } from "./db";
import { createStore } from "./observable";
import { getKeys, getSession } from "./session";

export interface SharedGroup {
  shareId: string;
  fromUser: string;
  fromEmail: string;
  playlist: Playlist;
  tracks: Record<string, Track>;
}

export interface SentShare {
  shareId: string;
  toEmail: string;
  playlistName: string;
}

export interface Library {
  tracks: Record<string, Track>;
  playlists: Record<string, Playlist>;
  plays: Record<string, Play>;
  shared: SharedGroup[];
  sent: SentShare[];
  loaded: boolean;
  syncing: boolean;
  error: string | null;
  /** Alterações feitas no aparelho que ainda não chegaram ao servidor. */
  pending: number;
  /** Sem conexão com o servidor (internet caiu ou servidor desligado): tudo segue salvo no aparelho. */
  offline: boolean;
  /** Quando o último sync completo deu certo. */
  lastSync: number | null;
}

const empty: Library = {
  tracks: {},
  playlists: {},
  plays: {},
  shared: [],
  sent: [],
  loaded: false,
  syncing: false,
  error: null,
  pending: 0,
  offline: false,
  lastSync: null,
};
export const libraryStore = createStore<Library>(empty);

const KIND_KEY = { track: "tracks", playlist: "playlists", play: "plays" } as const;
const MAX_PLAYS = 300;

// IDs de faixas compartilhadas: "s~<shareId>~<trackId>" (o til não aparece nos IDs normais).
export const sharedTrackId = (shareId: string, trackId: string) => `s~${shareId}~${trackId}`;

export function getTrack(id: string): Track | undefined {
  const lib = libraryStore.get();
  if (!id.startsWith("s~")) return lib.tracks[id];
  const [, shareId, trackId] = id.split("~");
  return lib.shared.find((g) => g.shareId === shareId)?.tracks[trackId];
}

// ---------------- Carregar do aparelho ----------------

export async function loadLocal() {
  const d = await db();
  const items = await d.getAll("items");
  const next: Library = { ...empty, tracks: {}, playlists: {}, plays: {} };
  for (const it of items) (next[KIND_KEY[it.kind]] as Record<string, unknown>)[it.id] = it.value;
  next.shared = (await kvGet<SharedGroup[]>("shared")) ?? [];
  next.sent = (await kvGet<SentShare[]>("sent")) ?? [];
  next.loaded = true;
  next.pending = await d.count("outbox");
  libraryStore.set(next);
}

/** Atualiza a contagem de alterações esperando envio. */
async function refreshPending() {
  // O histórico de reprodução vai em lote, sem pressa: não conta como "para enviar".
  const pending = (await (await db()).getAll("outbox")).filter((it) => it.kind !== "play").length;
  libraryStore.set((l) => ({ ...l, pending }));
}

export function resetLibrary() {
  libraryStore.set(empty);
}

// ---------------- Escritas locais (vão para a fila de envio) ----------------

function applyLocal(kind: ItemKind, id: string, value: unknown | null) {
  libraryStore.set((lib) => {
    const key = KIND_KEY[kind];
    const map = { ...lib[key] } as Record<string, unknown>;
    if (value === null) delete map[id];
    else map[id] = value;
    return { ...lib, [key]: map };
  });
}

/** Faixa que só existe neste aparelho (mais de 13 minutos): fica fora do sync. */
const isLocalTrack = (kind: ItemKind, value: unknown) => kind === "track" && !!(value as Track | undefined)?.local;

export async function saveItem<K extends ItemKind>(kind: K, id: string, value: ItemValue[K]) {
  applyLocal(kind, id, value);
  const d = await db();
  if (isLocalTrack(kind, value)) {
    await d.put("items", { id, kind, value });
    return;
  }
  const enc = await sealJSON(getKeys().enc, id, value);
  const tx = d.transaction(["items", "outbox"], "readwrite");
  await tx.objectStore("items").put({ id, kind, value });
  await tx.objectStore("outbox").put({ id, kind, enc, deleted: false });
  await tx.done;
  void refreshPending();
  scheduleSync(kind === "play" ? PLAYS_DELAY : undefined);
}

export async function deleteItem(kind: ItemKind, id: string) {
  const before = kind === "track" ? libraryStore.get().tracks[id] : undefined;
  applyLocal(kind, id, null);
  const d = await db();
  if (isLocalTrack(kind, before)) {
    // Não há outra cópia: o arquivo sai junto com a faixa.
    await d.delete("items", id);
    for (const ref of [...Object.values(before!.variants), before!.cover]) if (ref) await dropLocal(ref);
    return;
  }
  const tx = d.transaction(["items", "outbox"], "readwrite");
  await tx.objectStore("items").delete(id);
  await tx.objectStore("outbox").put({ id, kind, enc: null, deleted: true });
  await tx.done;
  void refreshPending();
  scheduleSync(kind === "play" ? PLAYS_DELAY : undefined);
}

export async function recordPlay(trackId: string) {
  await saveItem("play", randomId(), { trackId, at: Date.now() });
  const plays = Object.entries(libraryStore.get().plays).sort((a, b) => b[1].at - a[1].at);
  for (const [id] of plays.slice(MAX_PLAYS)) await deleteItem("play", id);
}

export async function createPlaylist(name: string, trackIds: string[] = []): Promise<string> {
  const id = randomId();
  await saveItem("playlist", id, { name, trackIds, createdAt: Date.now() });
  return id;
}

export async function addToPlaylist(playlistId: string, trackIds: string[]) {
  const p = libraryStore.get().playlists[playlistId];
  if (!p) return;
  const set = new Set(p.trackIds);
  await saveItem("playlist", playlistId, { ...p, trackIds: [...p.trackIds, ...trackIds.filter((t) => !set.has(t))] });
}

export async function removeFromPlaylist(playlistId: string, trackId: string) {
  const p = libraryStore.get().playlists[playlistId];
  if (p) await saveItem("playlist", playlistId, { ...p, trackIds: p.trackIds.filter((t) => t !== trackId) });
}

/** Faixas tocadas recentemente (sem repetir), da mais recente para a mais antiga. */
export function recentTrackIds(lib: Library, limit = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of Object.values(lib.plays).sort((a, b) => b.at - a.at)) {
    if (seen.has(p.trackId) || !getTrackFrom(lib, p.trackId)) continue;
    seen.add(p.trackId);
    out.push(p.trackId);
    if (out.length >= limit) break;
  }
  return out;
}

/** Favoritas, da marcada mais recentemente para a mais antiga. */
export function favoriteIds(lib: Library): string[] {
  return Object.entries(lib.tracks)
    .filter(([, t]) => t.favoriteAt)
    .sort((a, b) => b[1].favoriteAt! - a[1].favoriteAt!)
    .map(([id]) => id);
}

/** Mais tocadas no histórico guardado (pelo menos 2 vezes), da mais para a menos tocada. */
export function mostPlayedIds(lib: Library, limit = 20): string[] {
  const count = new Map<string, { n: number; last: number }>();
  for (const p of Object.values(lib.plays)) {
    const c = count.get(p.trackId) ?? { n: 0, last: 0 };
    count.set(p.trackId, { n: c.n + 1, last: Math.max(c.last, p.at) });
  }
  return [...count.entries()]
    .filter(([id, c]) => c.n >= 2 && getTrackFrom(lib, id))
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)
    .slice(0, limit)
    .map(([id]) => id);
}

const DAY = 24 * 60 * 60 * 1000;

/** Número estável por dia para cada id: as "esquecidas" mudam de um dia para o outro, não a cada tela. */
function dailyRank(id: string): number {
  const seed = `${id}:${Math.floor(Date.now() / DAY)}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Esquecidas: não tocadas há mais de 30 dias, ou nunca tocadas e na biblioteca
 * há mais de 14 dias. Uma seleção diferente a cada dia.
 */
export function forgottenIds(lib: Library, limit = 20): string[] {
  const last = new Map<string, number>();
  for (const p of Object.values(lib.plays)) last.set(p.trackId, Math.max(last.get(p.trackId) ?? 0, p.at));
  const now = Date.now();
  return Object.entries(lib.tracks)
    .filter(([id, t]) => {
      const l = last.get(id);
      return l ? l < now - 30 * DAY : t.addedAt < now - 14 * DAY;
    })
    .map(([id]) => id)
    .sort((a, b) => dailyRank(a) - dailyRank(b))
    .slice(0, limit);
}

export function getTrackFrom(lib: Library, id: string): Track | undefined {
  if (!id.startsWith("s~")) return lib.tracks[id];
  const [, shareId, trackId] = id.split("~");
  return lib.shared.find((g) => g.shareId === shareId)?.tracks[trackId];
}

// ---------------- Músicas só deste aparelho ----------------

export interface LocalTrackInput {
  audio: Uint8Array;
  mime: string;
  cover?: Uint8Array;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  /** Ex.: "youtube:<id>": pedir de novo não guarda duas vezes. */
  source: string;
}

/**
 * Põe na biblioteca deste aparelho uma música que não foi para o servidor (mais
 * de 13 minutos). O arquivo fica nos downloads e a faixa não sincroniza.
 */
export async function addLocalTrack(t: LocalTrackInput): Promise<string> {
  const lib = libraryStore.get();
  const known = Object.entries(lib.tracks).find(([, x]) => x.local && x.source === t.source);
  if (known) return known[0];
  const id = randomId();
  const audio = await keepLocal(id, "audio", t.audio, t.mime);
  const cover = t.cover ? await keepLocal(id, "cover", t.cover, "image/webp") : undefined;
  const track: Track = {
    title: t.title,
    artist: t.artist,
    album: t.album ?? "",
    genre: "",
    tags: [],
    duration: t.duration,
    sourceInfo: "só neste aparelho",
    variants: { orig: audio },
    ...(cover && { cover }),
    source: t.source,
    local: true,
    addedAt: Date.now(),
  };
  await saveItem("track", id, track);
  return id;
}

// ---------------- Sync com o servidor ----------------

let timer: ReturnType<typeof setTimeout> | null = null;
let due = Infinity;
let running: Promise<void> | null = null;

/**
 * Cada música tocada vira um item do histórico. Em vez de uma requisição por
 * música, o histórico vai junto com a próxima alteração, ou em lote a cada 5 min,
 * ou quando o app sai da tela.
 */
const PLAYS_DELAY = 5 * 60_000;

/** Envia as alterações daqui a pouco (várias seguidas vão numa requisição só). */
export function scheduleSync(delay = 2000) {
  const at = Date.now() + delay;
  if (timer && at >= due) return; // já tem um envio marcado para antes
  if (timer) clearTimeout(timer);
  due = at;
  timer = setTimeout(() => {
    timer = null;
    due = Infinity;
    void sync(true);
  }, delay);
}

/**
 * `pushOnly`: só envia o que mudou aqui (1 requisição). O sync completo também
 * busca o que mudou em outros aparelhos e é chamado pelo app de tempos em tempos.
 */
export function sync(pushOnly = false): Promise<void> {
  running ??= doSync(pushOnly).finally(() => (running = null));
  return running;
}

// Saindo da tela (trocou de app, bloqueou): manda o que ficou na fila, inclusive o histórico.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && timer) {
      clearTimeout(timer);
      timer = null;
      due = Infinity;
      void sync(true);
    }
  });
}

/**
 * Falha de conexão (sem internet, servidor desligado ou fora do ar), e não um erro de verdade.
 * Um 500 sem corpo JSON também conta: é o proxy do Vite (em dev) avisando que a API não responde.
 */
const isOffline = (e: unknown) =>
  e instanceof TypeError ||
  (e instanceof ApiError && ([502, 503, 504].includes(e.status) || (e.status === 500 && e.message === "Erro 500")));

/** Compartilhamentos mudam pouco: confere no máximo a cada 10 min (compartilhar/parar atualiza na hora). */
const SHARES_EVERY = 10 * 60_000;
let sharesAt = 0;

async function doSync(pushOnly = false) {
  if (!navigator.onLine) {
    libraryStore.set((l) => ({ ...l, offline: true }));
    return;
  }
  libraryStore.set((l) => ({ ...l, syncing: true }));
  try {
    await push();
    if (!pushOnly) {
      await pull();
      if (Date.now() - sharesAt > SHARES_EVERY) await refreshShares();
    }
    libraryStore.set((l) => ({ ...l, error: null, offline: false, ...(!pushOnly && { lastSync: Date.now() }) }));
  } catch (e) {
    // Sem servidor: nada se perde, as alterações ficam na fila e vão na próxima tentativa.
    if (isOffline(e)) libraryStore.set((l) => ({ ...l, offline: true, error: null }));
    else libraryStore.set((l) => ({ ...l, offline: false, error: (e as Error).message }));
  } finally {
    await refreshPending();
    libraryStore.set((l) => ({ ...l, syncing: false }));
  }
}

async function push() {
  const d = await db();
  const pending = await d.getAll("outbox");
  for (let i = 0; i < pending.length; i += 100) {
    const batch = pending.slice(i, i + 100);
    await api.json("/sync", { method: "POST", json: { items: batch } });
    const tx = d.transaction("outbox", "readwrite");
    // Só remove se não mudou enquanto enviava.
    for (const it of batch) {
      const cur = await tx.store.get(it.id);
      if (cur && cur.enc === it.enc && cur.deleted === it.deleted) await tx.store.delete(it.id);
    }
    await tx.done;
  }
}

async function pull() {
  const d = await db();
  const { enc } = getKeys();
  let cursor = (await kvGet<number>("cursor")) ?? 0;
  for (;;) {
    const res = await api.json<SyncPullResponse>(`/sync?since=${cursor}`);
    const pending = new Set(await d.getAllKeys("outbox"));
    const decoded = await Promise.all(
      res.items
        .filter((it) => !pending.has(it.id)) // a alteração local mais nova vence
        .map(async (it) => ({ it, value: it.deleted || !it.enc ? null : await openJSON(enc, it.id, it.enc).catch(() => null) })),
    );
    const tx = d.transaction("items", "readwrite");
    for (const { it, value } of decoded) {
      if (value === null) await tx.store.delete(it.id);
      else await tx.store.put({ id: it.id, kind: it.kind, value });
    }
    await tx.done;
    libraryStore.set((lib) => {
      const next = { ...lib, tracks: { ...lib.tracks }, playlists: { ...lib.playlists }, plays: { ...lib.plays } };
      for (const { it, value } of decoded) {
        const map = next[KIND_KEY[it.kind]] as Record<string, unknown>;
        if (value === null) delete map[it.id];
        else map[it.id] = value;
      }
      return next;
    });
    cursor = res.cursor;
    await kvSet("cursor", cursor);
    if (!res.more) break;
  }
}

// ---------------- Compartilhamento ----------------

async function refreshShares() {
  sharesAt = Date.now();
  const me = getSession().userId;
  const { shares } = await api.json<{ shares: ShareInfo[] }>("/shares");
  const shared: SharedGroup[] = [];
  const sent: SentShare[] = [];
  for (const s of shares) {
    if (s.toUser === me) {
      try {
        const payload = JSON.parse(fromUtf8.decode(await eciesOpen(getKeys().privateKey, s.payload))) as SharePayload;
        for (const t of Object.values(payload.tracks)) {
          // Arquivos criptografados são de quem compartilhou; os do catálogo são de todos.
          for (const v of Object.values(t.variants)) if (v && !v.shared) v.owner = s.fromUser;
          if (t.cover && !t.cover.shared) t.cover.owner = s.fromUser;
        }
        shared.push({ shareId: s.id, fromUser: s.fromUser, fromEmail: s.fromEmail, ...payload });
      } catch {
        /* compartilhamento ilegível: ignora */
      }
    } else {
      sent.push({ shareId: s.id, toEmail: s.toEmail, playlistName: "" });
    }
  }
  // O nome da playlist enviada vem do ID: "<playlistId>.<destinatário>".
  const lib = libraryStore.get();
  for (const s of sent) s.playlistName = lib.playlists[s.shareId.split(".")[0]]?.name ?? "(playlist removida)";
  await kvSet("shared", shared);
  await kvSet("sent", sent);
  libraryStore.set((l) => ({ ...l, shared, sent }));
}

const blobIdsOf = (t: Track) => [...Object.values(t.variants).map((v) => v!.id), ...(t.cover ? [t.cover.id] : [])];

/** Compartilha uma playlist (instantâneo). Repetir atualiza o conteúdo para a mesma pessoa. */
export async function sharePlaylist(playlistId: string, email: string) {
  const lib = libraryStore.get();
  const playlist = lib.playlists[playlistId];
  if (!playlist) throw new Error("Playlist não encontrada");
  const target = await api.json<{ userId: string; publicKey: string }>(`/users/lookup?email=${encodeURIComponent(email)}`);
  if (target.userId === getSession().userId) throw new Error("Esse é você 🙂");
  const tracks: Record<string, Track> = {};
  // As só deste aparelho (mais de 13 minutos) não têm como ir para outra pessoa.
  for (const id of playlist.trackIds) if (lib.tracks[id] && !lib.tracks[id].local) tracks[id] = lib.tracks[id];
  const payload: SharePayload = { playlist: { ...playlist, trackIds: Object.keys(tracks) }, tracks };
  const sealed = await eciesSeal(target.publicKey, utf8.encode(JSON.stringify(payload)));
  await api.json(`/shares/${playlistId}.${target.userId}`, {
    method: "PUT",
    json: { toUser: target.userId, payload: sealed, blobIds: Object.values(tracks).flatMap(blobIdsOf) },
  });
  await refreshShares();
}

export async function unshare(shareId: string) {
  await api.json(`/shares/${shareId}`, { method: "DELETE" });
  await refreshShares();
}

export { blobIdsOf };
