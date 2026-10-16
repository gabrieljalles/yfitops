import { kvGet, kvSet } from "./db";

// "Mapa da batida" de uma música: a força dos graves ao longo do tempo, para a
// nebulosa do player pulsar junto. É calculado UMA vez por música, no próprio
// aparelho, lendo o arquivo que o player já baixou (sem baixar nada a mais), e
// fica guardado. A música em si não passa por aqui: o <audio> toca como sempre,
// então nada muda com a tela bloqueada nem offline.

/** Pontos por segundo. 20 basta para o olho; 4 min de música dão ~5 KB. */
export const BEAT_RATE = 20;
/** Músicas mais longas que isso (sets, podcasts) ficam sem mapa: só o brilho respirando. */
const MAX_SECONDS = 20 * 60;

const memo = new Map<string, Promise<Uint8Array | null>>();

/** Mapa da batida do arquivo `key` (tocando em `url`). null = não deu para calcular. */
export function beatMap(key: string, url: string): Promise<Uint8Array | null> {
  let p = memo.get(key);
  if (!p) {
    p = load(key, url).catch((e) => {
      console.warn("Mapa da batida indisponível", e);
      return null;
    });
    memo.set(key, p);
  }
  return p;
}

async function load(key: string, url: string): Promise<Uint8Array | null> {
  const saved = await kvGet<Uint8Array>(`beat:${key}`);
  if (saved) return saved;
  const map = await compute(await (await fetch(url)).arrayBuffer());
  if (map) await kvSet(`beat:${key}`, map);
  return map;
}

/** Decodifica numa taxa baixa (gasta pouca memória) e filtra só os graves, onde está o bumbo. */
async function compute(bytes: ArrayBuffer): Promise<Uint8Array | null> {
  const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) return null;
  let rate = 8000;
  let audio: AudioBuffer;
  try {
    audio = await new Offline(1, 1, rate).decodeAudioData(bytes.slice(0));
  } catch {
    // Alguns navegadores não aceitam taxa tão baixa.
    rate = 22050;
    audio = await new Offline(1, 1, rate).decodeAudioData(bytes);
  }
  if (audio.duration > MAX_SECONDS) return null;

  const ctx = new Offline(1, Math.ceil(audio.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 160;
  src.connect(low).connect(ctx.destination);
  src.start();
  const bass = (await ctx.startRendering()).getChannelData(0);

  const win = Math.round(rate / BEAT_RATE);
  const n = Math.floor(bass.length / win);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * win, end = j + win; j < end; j++) sum += bass[j] * bass[j];
    rms[i] = Math.sqrt(sum / win);
  }
  // Compara cada momento com o pico recente (que vai baixando aos poucos): assim
  // a batida aparece igual em música alta ou baixa, e trecho calmo fica calmo.
  const out = new Uint8Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak * 0.985, rms[i], 1e-4);
    const v = (rms[i] / peak - 0.55) / 0.45;
    out[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return out;
}

/** Força da batida (0 a 1) no segundo `t` do mapa. */
export function beatAt(map: Uint8Array, t: number): number {
  const x = t * BEAT_RATE;
  const i = Math.floor(x);
  if (i < 0 || i >= map.length - 1) return 0;
  const f = x - i;
  return (map[i] * (1 - f) + map[i + 1] * f) / 255;
}
