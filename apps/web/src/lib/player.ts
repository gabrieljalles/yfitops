import type { BlobRef, Track } from "@yfitops/core";
import { coverUrl, offlineStore, pickVariant, readBlob, variantCandidates } from "./blobs";
import { getTrack, recordPlay } from "./library";
import { createStore } from "./observable";

export interface PlayerState {
  queue: string[];
  index: number;
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  error: string | null;
}

export const playerStore = createStore<PlayerState>({
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  time: 0,
  duration: 0,
  shuffle: false,
  repeat: "off",
  error: null,
});

const audio = new Audio();
audio.preload = "auto";
let currentUrl: string | null = null;
let loadToken = 0;
let playedFor = 0;
let counted = false;
/** Ordem original antes de embaralhar. */
let unshuffled: string[] | null = null;

const set = (patch: Partial<PlayerState>) => playerStore.set((s) => ({ ...s, ...patch }));

export const currentTrackId = () => {
  const s = playerStore.get();
  return s.queue[s.index];
};

// Músicas já decifradas recentemente (para voltar/avançar sem baixar de novo).
const decoded = new Map<string, string>();
function remember(id: string, url: string) {
  decoded.set(id, url);
  while (decoded.size > 4) {
    const [oldId, oldUrl] = decoded.entries().next().value!;
    if (oldUrl === currentUrl) break;
    URL.revokeObjectURL(oldUrl);
    decoded.delete(oldId);
  }
}

async function urlFor(id: string, ref: BlobRef): Promise<string> {
  const key = `${id}:${ref.id}`;
  const hit = decoded.get(key);
  if (hit) return hit;
  const bytes = await readBlob(ref);
  const url = URL.createObjectURL(new Blob([bytes], { type: ref.mime.split(";")[0] }));
  remember(key, url);
  return url;
}

/** Enquanto testa variantes, o evento "error" do <audio> não vira aviso na tela. */
let probing = false;

/** Carrega uma URL no <audio>; rejeita se o navegador não decodificar o formato. */
function tryLoad(url: string, autoplay: boolean): Promise<void> {
  audio.src = url;
  if (autoplay) return audio.play();
  return new Promise((resolve, reject) => {
    const ok = () => (cleanup(), resolve());
    const fail = () => (cleanup(), reject(audio.error ?? new Error("formato não suportado")));
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", ok);
      audio.removeEventListener("error", fail);
    };
    audio.addEventListener("loadedmetadata", ok);
    audio.addEventListener("error", fail);
  });
}

const isUnsupported = (e: unknown) =>
  (e as Error)?.name === "NotSupportedError" || (e instanceof MediaError && e.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED);

async function loadIndex(index: number, autoplay = true) {
  const { queue } = playerStore.get();
  const id = queue[index];
  const t = id ? getTrack(id) : undefined;
  if (!t) return;
  const token = ++loadToken;
  audio.pause();
  set({ index, loading: true, time: 0, duration: t.duration, error: null });
  playedFor = 0;
  counted = false;
  updateMediaSession(t);
  try {
    // Tenta as versões em ordem (ex.: FLAC → original → Opus) até uma tocar neste navegador.
    const candidates = variantCandidates(t, offlineStore.get());
    const unsupported: string[] = [];
    let played = false;
    probing = true;
    for (const ref of candidates) {
      const url = await urlFor(id, ref);
      if (token !== loadToken) return;
      currentUrl = url;
      try {
        await tryLoad(url, autoplay);
        played = true;
        break;
      } catch (e) {
        if (token !== loadToken) return;
        if (!isUnsupported(e)) throw e;
        console.warn(`Formato não tocável aqui: ${ref.mime}`, e);
        unsupported.push(ref.mime.split(";")[0]);
      }
    }
    if (!played) throw new Error(`Este navegador não toca este formato (${unsupported.join(", ")})`);
  } catch (e) {
    if (token === loadToken) {
      set({
        error: !navigator.onLine
          ? "Sem conexão e a música não está baixada"
          : (e as Error)?.name === "OperationError"
            ? "Não foi possível abrir este arquivo (chave não confere)"
            : (e as Error)?.message || "Não foi possível tocar esta música",
      });
    }
  } finally {
    if (token === loadToken) {
      probing = false;
      set({ loading: false });
    }
  }
  void prefetch(index + 1);
}

/** Baixa e decifra a próxima da fila, para a troca ser instantânea. */
async function prefetch(index: number) {
  const id = playerStore.get().queue[index];
  const t = id ? getTrack(id) : undefined;
  if (t) await urlFor(id, pickVariant(t, offlineStore.get())).catch(() => {});
}

export function playList(ids: string[], start = 0) {
  const s = playerStore.get();
  let queue = [...ids];
  let index = start;
  unshuffled = null;
  if (s.shuffle) {
    unshuffled = queue;
    const first = queue[start];
    queue = shuffleArray(queue.filter((_, i) => i !== start));
    queue.unshift(first);
    index = 0;
  }
  set({ queue });
  void loadIndex(index);
}

export function playNext(id: string) {
  const s = playerStore.get();
  if (s.index < 0) return playList([id]);
  const queue = [...s.queue];
  queue.splice(s.index + 1, 0, id);
  set({ queue });
}

export function addToQueue(ids: string[]) {
  const s = playerStore.get();
  if (s.index < 0) return playList(ids);
  set({ queue: [...s.queue, ...ids] });
}

export function jumpTo(index: number) {
  void loadIndex(index);
}

export function toggle() {
  if (playerStore.get().index < 0) return;
  if (audio.paused) void audio.play().catch(() => {});
  else audio.pause();
}

export function next(auto = false) {
  const s = playerStore.get();
  if (auto && s.repeat === "one") {
    audio.currentTime = 0;
    void audio.play();
    return;
  }
  if (s.index + 1 < s.queue.length) void loadIndex(s.index + 1);
  else if (s.repeat === "all" && s.queue.length) void loadIndex(0);
  else if (auto) set({ playing: false });
}

export function prev() {
  const s = playerStore.get();
  if (audio.currentTime > 3 || s.index === 0) audio.currentTime = 0;
  else void loadIndex(s.index - 1);
}

export function seek(seconds: number) {
  audio.currentTime = seconds;
  set({ time: seconds });
}

export function toggleShuffle() {
  const s = playerStore.get();
  const current = s.queue[s.index];
  if (!s.shuffle) {
    unshuffled = s.queue;
    const rest = shuffleArray(s.queue.filter((_, i) => i !== s.index));
    set({ shuffle: true, queue: current ? [current, ...rest] : rest, index: current ? 0 : -1 });
  } else {
    const queue = unshuffled ?? s.queue;
    set({ shuffle: false, queue, index: Math.max(0, queue.indexOf(current)) });
    unshuffled = null;
  }
}

export function cycleRepeat() {
  const order = ["off", "all", "one"] as const;
  const r = playerStore.get().repeat;
  set({ repeat: order[(order.indexOf(r) + 1) % 3] });
}

function shuffleArray<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------- Eventos do <audio> ----------------

let lastTick = 0;
audio.addEventListener("timeupdate", () => {
  const now = audio.currentTime;
  if (Math.abs(now - lastTick) < 2 && !audio.paused) playedFor += Math.max(0, now - lastTick);
  lastTick = now;
  // Conta como "tocada" após 30 s (ou metade, para músicas curtas).
  const id = currentTrackId();
  if (!counted && id && playedFor >= Math.min(30, (audio.duration || 60) / 2)) {
    counted = true;
    void recordPlay(id);
  }
  set({ time: now });
  if ("mediaSession" in navigator && audio.duration) {
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, position: now, playbackRate: 1 });
    } catch {
      /* alguns navegadores reclamam durante a troca de faixa */
    }
  }
});
audio.addEventListener("durationchange", () => set({ duration: audio.duration || 0 }));
audio.addEventListener("play", () => set({ playing: true }));
audio.addEventListener("pause", () => set({ playing: false }));
audio.addEventListener("ended", () => next(true));
audio.addEventListener("error", () => !probing && set({ error: "Não foi possível tocar este arquivo", loading: false }));

// ---------------- Controles do sistema (tela bloqueada, fone, notificação) ----------------

function updateMediaSession(t: Track) {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album });
  if (t.cover) {
    void coverUrl(t.cover).then((src) => {
      if (getTrack(currentTrackId() ?? "") === t) {
        ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: [{ src, sizes: "300x300", type: "image/webp" }] });
      }
    });
  }
}

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => toggle());
  ms.setActionHandler("pause", () => toggle());
  ms.setActionHandler("nexttrack", () => next());
  ms.setActionHandler("previoustrack", () => prev());
  ms.setActionHandler("seekto", (d) => d.seekTime != null && seek(d.seekTime));
}

export function stop() {
  audio.pause();
  audio.removeAttribute("src");
  set({ queue: [], index: -1, playing: false, time: 0 });
}
