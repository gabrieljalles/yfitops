import { MAX_SONG_SECONDS, type ResolvedTrack, type SongQuery, type SpotFailKind, type SpotJob } from "@yfitops/core";
import { api, ApiError } from "./api";
import { artistFromChannel, splitArtistTitle } from "./artist";
import { findInCatalog } from "./catalog";
import { makeCover, publishForQueue } from "./importer";
import { addLocalTrack, getTrack } from "./library";
import { canSpot, deviceId, holdAwake, keepAlive, onNativeAction, onWifi, watchNetwork } from "./native";
import { createStore } from "./observable";
import { currentTrackId, playerStore, toggle } from "./player";
import { sessionStore } from "./session";
import { downloadAudio, fetchCover, readLink, searchYouTube, SourceError } from "./sources";

// ---------------------------------------------------------------------------
// Este celular ajudando a fila de importação (só no app Android).
//
// Regras:
//   - todo app Android ajuda (não há como desligar);
//   - só no Wi-Fi (quem baixa para os outros não gasta dados móveis);
//   - só com o app aberto na tela, ou tocando música (aí vale com a tela
//     desligada). Pausou a música, ou saiu do app sem música: para na hora, e
//     o que estava baixando volta para a fila;
//   - revezam: quem acabou de baixar passa a vez (o servidor decide).
// ---------------------------------------------------------------------------

export interface SpotState {
  /** Este aparelho consegue ajudar (app Android). */
  capable: boolean;
  /** Ajudando agora. */
  active: boolean;
  /** Por que não está ajudando (quando não está). */
  reason: string;
  /** O que está fazendo agora ("baixando X"). */
  doing: string;
  /** Músicas que este aparelho baixou para a fila desde que abriu o app. */
  done: number;
  /** O YouTube barrou este aparelho: ele descansa e os outros seguem. */
  resting: boolean;
}

export const spotStore = createStore<SpotState>({ capable: false, active: false, reason: "", doing: "", done: 0, resting: false });
const patch = (p: Partial<SpotState>) => spotStore.set((s) => ({ ...s, ...p }));

let wifi = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let started = false;
/** Já avisou o servidor que está disponível (para avisar quando sair). */
let announced = false;

/** O app parou de poder ajudar no meio de um download. */
class Stopped extends Error {}

/** Pode ajudar agora? Devolve "" se sim, ou o motivo. */
function blocker(): string {
  const s = sessionStore.get();
  if (!s || s.status === "pending") return "sem conta";
  if (!wifi) return "só ajuda no Wi-Fi";
  if (document.visibilityState !== "visible" && !playerStore.get().playing) return "só com o app aberto ou tocando música";
  return "";
}

/** Para no meio se não puder mais (pausou, saiu do app, saiu do Wi-Fi). */
function check() {
  if (blocker()) throw new Stopped();
}

function schedule(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
}

/** Algo mudou (tela, música, Wi-Fi, ajuste): reavalia logo. */
function kick() {
  const why = blocker();
  patch({ active: !why, reason: why });
  if (why && announced && !running) void leave();
  if (!running) schedule(why ? 30_000 : 500);
}

async function leave() {
  announced = false;
  await api.json("/spot/leave", { method: "POST", json: { device: deviceId() } }).catch(() => {});
}

async function tick() {
  if (running) return;
  const why = blocker();
  patch({ active: !why, reason: why });
  if (why) return schedule(30_000);
  running = true;
  let next = 60_000;
  try {
    const res = await api.json<{ job: SpotJob | null; wait?: number; resting?: boolean }>("/spot/claim", {
      method: "POST",
      json: { device: deviceId() },
    });
    announced = true;
    patch({ resting: !!res.resting });
    if (res.job) {
      await work(res.job);
      // Acabou: pede de novo logo (o servidor passa a vez se houver outro celular).
      next = 1_000;
    } else next = (res.wait ?? 60) * 1000;
  } catch (e) {
    if (e instanceof Stopped) {
      await leave();
      next = 30_000;
    }
  } finally {
    running = false;
    holdAwake(false);
    patch({ doing: "" });
    if (blocker() && announced) void leave();
    schedule(next);
  }
}

/** Origem no catálogo (ex.: "spotify:<id>"). */
const catalogKey = (t: ResolvedTrack) => (t.spotifyId ? `spotify:${t.spotifyId}` : t.deezerId ? `deezer:${t.deezerId}` : undefined);

/** O que procurar no catálogo antes de baixar (mesma origem, ou mesmo artista/título/duração). */
function catalogQuery(t: ResolvedTrack): SongQuery {
  const split = t.query ? null : splitArtistTitle(t.title);
  return {
    artist: split?.artist || (t.query ? t.artist : artistFromChannel(t.artist) || t.artist),
    title: split?.title || t.title,
    duration: t.duration,
    sources: [t.videoId && `youtube:${t.videoId}`, catalogKey(t)].filter((x): x is string => !!x),
  };
}

const inCatalog = (t: ResolvedTrack) => findInCatalog(catalogQuery(t)).catch(() => null);

async function work(job: SpotJob) {
  const device = deviceId();
  if (job.type === "list") {
    try {
      patch({ doing: "lendo um link" });
      const listing = await readLink(job.url);
      check();
      // As que já estão no catálogo saem prontas (ninguém baixa de novo).
      const tracks: { meta: ResolvedTrack; songId?: string }[] = [];
      for (let i = 0; i < listing.tracks.length; i += 6) {
        const slice = listing.tracks.slice(i, i + 6);
        const found = await Promise.all(slice.map(inCatalog));
        slice.forEach((meta, k) => tracks.push({ meta, ...(found[k] && { songId: found[k]!.id }) }));
      }
      await report(`/spot/list/${job.id}`, { device, provider: listing.provider, source: listing.source, name: listing.name, truncated: listing.truncated, tracks });
    } catch (e) {
      if (e instanceof Stopped) throw e;
      await report(`/spot/list/${job.id}`, { device, ...failureOf(e) });
    }
    return;
  }

  const t: ResolvedTrack = { ...job.meta };
  const label = t.title || "uma música";
  try {
    // Alguém pode ter trazido enquanto ela esperava na fila.
    const known = await inCatalog(t);
    if (known) return await report(`/spot/track/${job.id}`, { device, songId: known.id });
    if (!t.videoId) {
      patch({ doing: `procurando "${label}" no YouTube` });
      const hit = await searchYouTube(t);
      t.videoId = hit.videoId;
      if (!t.title) t.title = hit.title;
      if (!t.artist) t.artist = hit.artist;
      if (!t.duration) t.duration = hit.duration;
      const again = await inCatalog(t);
      if (again) return await report(`/spot/track/${job.id}`, { device, songId: again.id });
    }
    check();
    holdAwake(true);
    patch({ doing: `baixando "${label}"` });
    const dl = await downloadAudio(t.videoId);
    check();
    // Mais de 13 minutos não vai para o servidor. Se o pedido é de outra pessoa, este
    // celular não fica com ela: volta para a fila, para o celular de quem pediu.
    const seconds = dl.duration || t.duration;
    const tooLong = seconds > MAX_SONG_SECONDS;
    if (tooLong && !job.mine) return await report(`/spot/track/${job.id}`, { device, tooLong: true, duration: seconds });
    // Do Spotify/Deezer ficam o título e o artista de lá (mais limpos). Do YouTube:
    // "Artista - Título" no nome do vídeo; senão o canal, se for oficial ("- Topic", VEVO).
    if (!t.query || !t.artist) {
      const videoTitle = dl.title || t.title;
      const split = splitArtistTitle(videoTitle);
      t.artist = split?.artist || artistFromChannel(dl.channel) || artistFromChannel(t.artist);
      t.title = split?.title || videoTitle;
    }
    const cover = await fetchCover(t, t.videoId);
    check();
    if (tooLong) {
      // O pedido é seu: a música fica só neste celular (com o selo "local").
      patch({ doing: `guardando "${label}" neste celular` });
      await addLocalTrack({
        audio: new Uint8Array(await dl.file.arrayBuffer()),
        mime: dl.file.type || "audio/webm",
        cover: cover ? await makeCover(cover).catch(() => undefined) : undefined,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: seconds,
        source: `youtube:${t.videoId}`,
      });
      return await report(`/spot/track/${job.id}`, { device, tooLong: true, local: true, duration: seconds });
    }
    const songId = await publishForQueue(dl.file, {
      cover,
      source: `youtube:${t.videoId}`,
      title: t.title,
      artist: t.artist,
      album: t.album,
      alsoFrom: catalogKey(t) ? [catalogKey(t)!] : undefined,
    }, (status) => patch({ doing: `${status} "${label}"` }));
    await report(`/spot/track/${job.id}`, { device, songId });
    patch({ done: spotStore.get().done + 1 });
  } catch (e) {
    if (e instanceof Stopped) throw e;
    await report(`/spot/track/${job.id}`, { device, ...failureOf(e) });
  }
}

function failureOf(e: unknown): { error: string; kind: SpotFailKind } {
  if (e instanceof SourceError) return { error: e.message, kind: e.kind };
  return { error: String((e as Error)?.message ?? e).slice(0, 200) || "Erro ao baixar", kind: "temp" };
}

/** Responde ao servidor. Se a tarefa já não é deste aparelho (409), segue em frente. */
async function report(path: string, json: unknown) {
  try {
    await api.json(path, { method: "POST", json });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e;
  }
}

/**
 * Liga o ajudante (uma vez, depois do login). No navegador comum não faz nada:
 * só o app Android consegue baixar do YouTube.
 */
export function startSpot() {
  if (started || !canSpot()) return;
  started = true;
  patch({ capable: true });
  const refreshWifi = () =>
    void onWifi().then((w) => {
      wifi = w;
      kick();
    });
  refreshWifi();
  watchNetwork(refreshWifi);
  document.addEventListener("visibilitychange", kick);
  sessionStore.subscribe(kick);
  // "Pausar" na notificação (com a tela desligada não dá para abrir o app e pausar).
  onNativeAction((action) => action === "pause" && playerStore.get().playing && toggle());
  // Tocando: o app continua vivo com a tela desligada (e pode ajudar).
  let wasPlaying = false;
  playerStore.subscribe(() => {
    const { playing } = playerStore.get();
    if (playing === wasPlaying) return;
    wasPlaying = playing;
    const t = getTrack(currentTrackId() ?? "");
    keepAlive(playing, t?.title, t?.artist);
    kick();
  });
}
