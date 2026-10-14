import type { BlobRef, Track } from "@yfitops/core";
import { coverUrl, offlineStore, pickVariant, readBlob, variantCandidates } from "./blobs";
import { getTrack, recordPlay } from "./library";
import { createStore } from "./observable";
import { prefsStore } from "./prefs";

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

/**
 * Dois <audio> ("decks"): na transição suave (crossfade), a música que acaba
 * vai sumindo num deles enquanto a próxima entra no outro. `audio` é sempre o
 * deck ativo; os eventos do outro são ignorados.
 */
const decks = [new Audio(), new Audio()];
for (const d of decks) d.preload = "auto";
let audio = decks[0];
const otherDeck = () => (audio === decks[0] ? decks[1] : decks[0]);

/**
 * Alguns aparelhos (iPhone/iPad) não deixam o site mudar o volume do <audio>:
 * lá a transição viraria duas músicas tocando juntas, então fica indisponível.
 */
export const canCrossfade = (() => {
  const a = new Audio();
  a.volume = 0.5;
  return a.volume === 0.5;
})();

/** Transição em andamento: o deck que está saindo e o "relógio" do volume. */
let fade: { from: HTMLAudioElement; timer: ReturnType<typeof setInterval> } | null = null;
/** Já começou a transição para a próxima nesta música? */
let crossStarted = false;

/** Termina a transição na hora: o deck que saía para, o ativo fica no volume cheio. */
function endFade() {
  if (!fade) return;
  clearInterval(fade.timer);
  fade.from.pause();
  fade.from.volume = 1;
  audio.volume = 1;
  fade = null;
}

/** Curva de potência constante: o volume somado dos dois não "afunda" no meio. */
function startFade(from: HTMLAudioElement, seconds: number) {
  const started = performance.now();
  const timer = setInterval(() => {
    const k = Math.min(1, (performance.now() - started) / (seconds * 1000));
    audio.volume = Math.sin((k * Math.PI) / 2);
    from.volume = Math.cos((k * Math.PI) / 2);
    if (k >= 1) endFade();
  }, 50);
  fade = { from, timer };
}

let currentUrl: string | null = null;
let loadToken = 0;
let playedFor = 0;
let lastTick = 0;
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
    // Não solta a música de nenhum deck (na transição, as duas estão tocando).
    if (oldUrl === currentUrl || decks.some((d) => d.src === oldUrl)) break;
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
  const el = audio;
  el.src = url;
  if (autoplay) return el.play();
  return new Promise((resolve, reject) => {
    const ok = () => (cleanup(), resolve());
    const fail = () => (cleanup(), reject(el.error ?? new Error("formato não suportado")));
    const cleanup = () => {
      el.removeEventListener("loadedmetadata", ok);
      el.removeEventListener("error", fail);
    };
    el.addEventListener("loadedmetadata", ok);
    el.addEventListener("error", fail);
  });
}

const isUnsupported = (e: unknown) =>
  (e as Error)?.name === "NotSupportedError" || (e instanceof MediaError && e.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED);

/**
 * Carrega e toca a música `index` da fila. Com `crossfade` (segundos), a atual
 * continua tocando no outro deck e vai sumindo enquanto a nova entra.
 */
async function loadIndex(index: number, autoplay = true, crossfade = 0) {
  const { queue } = playerStore.get();
  const id = queue[index];
  const t = id ? getTrack(id) : undefined;
  if (!t) return;
  const token = ++loadToken;
  let fadingFrom: HTMLAudioElement | null = null;
  if (crossfade > 0 && !audio.paused) {
    endFade();
    fadingFrom = audio;
    audio = otherDeck();
    audio.volume = 0;
  } else {
    // Troca "na mão" (próxima, anterior, escolher outra): corta na hora.
    endFade();
    audio.pause();
    audio.volume = 1;
  }
  crossStarted = false;
  set({ index, loading: true, time: 0, duration: t.duration, error: null });
  playedFor = 0;
  lastTick = 0;
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
    if (fadingFrom) startFade(fadingFrom, crossfade);
  } catch (e) {
    // A nova não tocou: a que estava saindo para, e o deck ativo volta ao volume cheio.
    if (fadingFrom) {
      fadingFrom.pause();
      fadingFrom.volume = 1;
      audio.volume = 1;
    }
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
  endFade(); // pausar no meio da transição para as duas
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
  endFade();
  // Voltou para antes do ponto da transição: ela pode acontecer de novo.
  crossStarted = false;
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

/** Próxima da fila para a transição suave (null = não há ou é "repetir uma"). */
function crossfadeTarget(): number | null {
  const s = playerStore.get();
  if (s.repeat === "one") return null;
  if (s.index + 1 < s.queue.length) return s.index + 1;
  return s.repeat === "all" && s.queue.length > 1 ? 0 : null;
}

function onTimeUpdate() {
  const now = audio.currentTime;
  if (Math.abs(now - lastTick) < 2 && !audio.paused) playedFor += Math.max(0, now - lastTick);
  lastTick = now;
  // Conta como "tocada" após 30 s (ou metade, para músicas curtas).
  const id = currentTrackId();
  if (!counted && id && playedFor >= Math.min(30, (audio.duration || 60) / 2)) {
    counted = true;
    void recordPlay(id);
  }
  // Transição suave: perto do fim, a próxima começa no outro deck.
  const cf = canCrossfade ? prefsStore.get().crossfade : 0;
  const left = audio.duration - now;
  if (cf > 0 && !crossStarted && !fade && audio.duration > cf * 2 && left <= cf && !audio.paused) {
    const target = crossfadeTarget();
    if (target !== null) {
      crossStarted = true;
      void loadIndex(target, true, Math.max(1, left));
    }
  }
  set({ time: now });
  if ("mediaSession" in navigator && audio.duration) {
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, position: now, playbackRate: 1 });
    } catch {
      /* alguns navegadores reclamam durante a troca de faixa */
    }
  }
}

// Os dois decks escutam os mesmos eventos, mas só o ativo mexe no estado: o que
// está saindo numa transição termina ("ended"/"pause") sem afetar a música nova.
for (const deck of decks) {
  const active = (fn: () => void) => () => deck === audio && fn();
  deck.addEventListener("timeupdate", active(onTimeUpdate));
  deck.addEventListener("durationchange", active(() => set({ duration: audio.duration || 0 })));
  deck.addEventListener("play", active(() => set({ playing: true })));
  deck.addEventListener("pause", active(() => set({ playing: false })));
  deck.addEventListener("ended", active(() => next(true)));
  deck.addEventListener("error", active(() => !probing && set({ error: "Não foi possível tocar este arquivo", loading: false })));
}

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
  endFade();
  for (const d of decks) {
    d.pause();
    d.removeAttribute("src");
  }
  set({ queue: [], index: -1, playing: false, time: 0 });
}
