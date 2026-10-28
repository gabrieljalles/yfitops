import { MAX_SONG_SECONDS, type ResolvedTrack, type SongQuery, type SpotFailKind, type SpotJob } from "@yfitops/core";
import { api, ApiError } from "./api";
import { artistFromChannel, splitArtistTitle } from "./artist";
import { findInCatalog } from "./catalog";
import { makeCover, publishForQueue } from "./importer";
import { addLocalTrack, getTrack } from "./library";
import { canSpot, deviceId, holdAwake, nativeHelper, nowPlaying, onNativeAction, onWifi, watchNetwork } from "./native";
import { createStore } from "./observable";
import { currentTrackId, next, playerStore, prev, seek, toggle } from "./player";
import { sessionStore } from "./session";
import { downloadAudio, fetchCover, readLink, searchYouTube, SourceError } from "./sources";

// ---------------------------------------------------------------------------
// Este celular ajudando a fila de importação (só no app Android).
//
// Regras:
//   - todo app Android ajuda (não há como desligar);
//   - no Wi-Fi: baixa para todo mundo, com o app aberto na tela ou tocando
//     música (aí vale com a tela desligada). Pausou a música, ou saiu do app
//     sem música: para na hora, e o que estava baixando volta para a fila;
//   - nos dados móveis: só os pedidos da própria pessoa, e só com o app aberto
//     na tela (quem baixa para os outros não gasta dados móveis);
//   - celular ajudante (ligado em Ajustes, só pelo administrador): baixa o
//     tempo todo no Wi-Fi, com a tela desligada e sem música. Ele não fica com
//     as músicas longas da própria conta (essas vão para o celular principal);
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
  /** Celular ajudante: baixa 24 horas, com a tela desligada e sem música. */
  helper: boolean;
}

/** Guardado neste aparelho: é o celular ajudante. */
const HELPER_KEY = "yfitops.helper";

function savedHelper(): boolean {
  try {
    return localStorage.getItem(HELPER_KEY) === "1";
  } catch {
    return false;
  }
}

export const spotStore = createStore<SpotState>({ capable: false, active: false, reason: "", doing: "", done: 0, resting: false, helper: savedHelper() });
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
  const visible = document.visibilityState === "visible";
  if (spotStore.get().helper && wifi) return "";
  if (!wifi && !visible) return "fora do Wi-Fi, só baixa os seus pedidos e com o app aberto";
  if (!visible && !playerStore.get().playing) return "só com o app aberto ou tocando música";
  return "";
}

/** Liga ou desliga o modo "celular ajudante" neste aparelho. */
export function setHelper(on: boolean) {
  try {
    if (on) localStorage.setItem(HELPER_KEY, "1");
    else localStorage.removeItem(HELPER_KEY);
  } catch {
    /* sem armazenamento: vale até fechar o app */
  }
  patch({ helper: on });
  nativeHelper(on);
  kick();
}

/** Nos dados móveis: só os pedidos da própria pessoa. */
const mineOnly = () => !wifi;

/** O que este aparelho está baixando agora (para saber se é pedido seu). */
let current: SpotJob | null = null;

/** Para no meio se não puder mais (pausou, saiu do app, saiu do Wi-Fi com pedido de outra pessoa). */
function check() {
  if (blocker()) throw new Stopped();
  // Ler um link é só texto: termina mesmo que o Wi-Fi caia no meio.
  if (mineOnly() && current?.type === "track" && !current.mine) throw new Stopped();
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
      json: { device: deviceId(), mineOnly: mineOnly(), helper: spotStore.get().helper },
    });
    announced = true;
    patch({ resting: !!res.resting });
    if (res.job) {
      current = res.job;
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
    current = null;
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
    // Mais de 13 minutos não vai para o servidor. Se o pedido é de outra pessoa (ou este
    // é o celular ajudante), este celular não fica com ela: volta para a fila, para o
    // celular de quem pediu.
    const seconds = dl.duration || t.duration;
    const tooLong = seconds > MAX_SONG_SECONDS;
    const keep = job.mine && !spotStore.get().helper;
    if (tooLong && !keep) return await report(`/spot/track/${job.id}`, { device, tooLong: true, duration: seconds });
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
  if (spotStore.get().helper) nativeHelper(true);
  const refreshWifi = () =>
    void onWifi().then((w) => {
      wifi = w;
      kick();
    });
  refreshWifi();
  watchNetwork(refreshWifi);
  document.addEventListener("visibilitychange", kick);
  sessionStore.subscribe(kick);
  // Comandos do Android: notificação, carro, fone Bluetooth e tela bloqueada.
  onNativeAction((action) => {
    const { playing, index } = playerStore.get();
    if (action === "play") !playing && index >= 0 && toggle();
    else if (action === "pause") playing && toggle();
    else if (action === "next") next();
    else if (action === "prev") prev();
    else if (action.startsWith("seek:")) seek(Number(action.slice(5)) || 0);
  });
  // O que está tocando vai para o Android (o app continua vivo com a tela desligada
  // e o carro mostra a música). Manda só quando muda: música, play/pause ou um pulo.
  let last = "";
  let lastTime = 0;
  let lastAt = 0;
  let wasPlaying = false;
  playerStore.subscribe(() => {
    const s = playerStore.get();
    const id = currentTrackId();
    const t = id ? getTrack(id) : undefined;
    if (s.playing !== wasPlaying) {
      wasPlaying = s.playing;
      kick();
    }
    if (!t || s.index < 0) {
      if (last) nowPlaying(null);
      last = "";
      return;
    }
    // Pulo: a posição não bate com o tempo que passou desde a última vez.
    const expected = lastTime + (wasPlaying ? (Date.now() - lastAt) / 1000 : 0);
    const jumped = Math.abs(s.time - expected) > 2.5;
    const key = `${id}|${s.playing}|${Math.round(s.duration)}`;
    if (key === last && !jumped) return;
    last = key;
    lastTime = s.time;
    lastAt = Date.now();
    nowPlaying({ title: t.title, artist: t.artist, album: t.album, playing: s.playing, position: s.time, duration: s.duration || t.duration });
  });
}
