import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { ArrayBufferTarget, Muxer } from "webm-muxer";

// O núcleo do FFmpeg (~30 MB) vem do CDN uma vez e fica no cache do navegador.
// É grande demais para os assets do Workers (limite de 25 MB por arquivo).
const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

let instance: Promise<FFmpeg> | null = null;
let progressCb: ((p: number) => void) | null = null;
/** Últimas linhas do log, anexadas às mensagens de erro. */
const recentLog: string[] = [];

function load(): Promise<FFmpeg> {
  instance ??= (async () => {
    const ff = new FFmpeg();
    ff.on("progress", ({ progress }) => progressCb?.(Math.max(0, Math.min(1, progress))));
    ff.on("log", ({ message }) => {
      recentLog.push(message);
      if (recentLog.length > 12) recentLog.shift();
    });
    await ff.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    return ff;
  })();
  instance.catch(() => (instance = null));
  return instance;
}

async function run(ff: FFmpeg, args: string[], onProgress?: (p: number) => void) {
  progressCb = onProgress ?? null;
  recentLog.length = 0;
  let code: number;
  try {
    code = await ff.exec(args);
  } catch (e) {
    console.error(`FFmpeg: ${args.join(" ")}\n${recentLog.join("\n")}`);
    throw e;
  } finally {
    progressCb = null;
  }
  if (code !== 0) {
    console.error(`FFmpeg: ${args.join(" ")}\n${recentLog.join("\n")}`);
    throw new Error(`FFmpeg falhou ao gerar ${args.at(-1)}: ${recentLog.at(-1) ?? ""}`);
  }
}

async function readText(ff: FFmpeg, path: string): Promise<string> {
  const data = await ff.readFile(path, "utf8");
  return String(data).trim();
}

/** MD5 do áudio decodificado em float64: igual ⇔ amostras idênticas (inteiras ou float). */
async function pcmMd5(ff: FFmpeg, input: string, out: string): Promise<string> {
  await run(ff, ["-i", input, "-map", "0:a:0", "-c:a", "pcm_f64le", "-f", "md5", out]);
  return readText(ff, out);
}

export interface LosslessResult {
  /** FLAC verificado; ausente se a verificação falhar (aí guardamos o original). */
  flac?: Uint8Array;
  /** Versão leve para streaming. */
  light: { data: Uint8Array; mime: string };
}

export type Stage = "carregando FFmpeg" | "FLAC" | "verificando" | "versão leve" | "DSD → FLAC" | "extraindo áudio" | "MP3";

const TEMP_FILES = ["out.flac", "pcm.f32", "out.m4a", "out.mp3", "a.md5", "b.md5"];

/** Qualidade das músicas do catálogo. */
export const MP3_KBPS = 192;

/**
 * Converte qualquer áudio (ou vídeo) para MP3 192 kbps, o formato único do
 * catálogo. Sem tags no arquivo: título e artista ficam no catálogo.
 * `copy`: já é MP3 leve; só tira as tags e a capa embutida, sem reconverter
 * (reconverter MP3 em MP3 só piora o som).
 */
export function toMp3(
  input: Uint8Array,
  ext: string,
  onStage: (stage: Stage, progress: number) => void,
  copy = false,
): Promise<Uint8Array> {
  return withInput(input, ext, onStage, async (ff, src) => {
    const codec = copy
      ? ["-c:a", "copy"]
      : // MP3 vai até 48 kHz: fontes de alta resolução (96 kHz, DSD) descem para 44,1 kHz.
        ["-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", `${MP3_KBPS}k`];
    await run(
      ff,
      ["-i", src, "-map", "0:a:0", "-vn", "-map_metadata", "-1", ...codec, "-id3v2_version", "0", "-write_xing", "1", "out.mp3"],
      (p) => onStage("MP3", p),
    );
    return (await ff.readFile("out.mp3")) as Uint8Array;
  });
}

/** Carrega o FFmpeg, grava a entrada e limpa os arquivos temporários no fim. */
async function withInput<T>(
  input: Uint8Array,
  ext: string,
  onStage: (stage: Stage, progress: number) => void,
  fn: (ff: FFmpeg, src: string) => Promise<T>,
): Promise<T> {
  onStage("carregando FFmpeg", 0);
  const ff = await load();
  const src = `in.${ext.replace(/[^a-z0-9]/gi, "") || "bin"}`;
  // writeFile transfere o buffer para o worker; mandamos uma cópia.
  await ff.writeFile(src, input.slice());
  try {
    return await fn(ff, src);
  } finally {
    for (const f of [src, ...TEMP_FILES]) await ff.deleteFile(f).catch(() => {});
  }
}

/**
 * Converte uma fonte lossless em FLAC (sem perda, nível 8) e numa versão leve.
 * O FLAC só é aceito se o áudio decodificado for idêntico, bit a bit, ao da fonte.
 */
export function transcodeLossless(
  input: Uint8Array,
  ext: string,
  onStage: (stage: Stage, progress: number) => void,
): Promise<LosslessResult> {
  return withInput(input, ext, onStage, async (ff, src) => {
    let flac: Uint8Array | undefined;
    await run(
      ff,
      ["-i", src, "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "8", "out.flac"],
      (p) => onStage("FLAC", p),
    );
    onStage("verificando", 0);
    const [a, b] = [await pcmMd5(ff, src, "a.md5"), await pcmMd5(ff, "out.flac", "b.md5")];
    if (a && a === b) {
      flac = (await ff.readFile("out.flac")) as Uint8Array;
      // Fonte já em FLAC e menor que a reconversão: mantém a fonte (também é lossless).
      if (ext.toLowerCase() === "flac" && input.length <= flac.length) flac = input;
    }
    const light = await makeLight(ff, src, (p) => onStage("versão leve", p));
    return { flac, light };
  });
}

/**
 * DSD (DSF/DFF) → FLAC 24-bit/176,4 kHz: a conversão DSD→PCM padrão de masterização.
 * Não é bit a bit (o DSD não tem amostras PCM), mas preserva todo o áudio até ~40 kHz.
 */
export function transcodeDsd(
  input: Uint8Array,
  ext: string,
  onStage: (stage: Stage, progress: number) => void,
): Promise<{ flac: Uint8Array; light: { data: Uint8Array; mime: string } }> {
  return withInput(input, ext, onStage, async (ff, src) => {
    await run(
      ff,
      [
        "-i", src, "-map", "0:a:0", "-map_metadata", "-1",
        "-af", "lowpass=f=40000", "-ar", "176400", "-sample_fmt", "s32", "-bits_per_raw_sample", "24",
        "-c:a", "flac", "-compression_level", "8", "out.flac",
      ],
      (p) => onStage("DSD → FLAC", p),
    );
    const flac = (await ff.readFile("out.flac")) as Uint8Array;
    const light = await makeLight(ff, src, (p) => onStage("versão leve", p));
    return { flac, light };
  });
}

/** Só a versão leve (para formatos com perda que o navegador não toca). O original fica intacto. */
export function lightOnly(
  input: Uint8Array,
  ext: string,
  onStage: (stage: Stage, progress: number) => void,
): Promise<{ data: Uint8Array; mime: string }> {
  return withInput(input, ext, onStage, (ff, src) => makeLight(ff, src, (p) => onStage("versão leve", p)));
}

/** Separa o áudio de um vídeo copiando o stream (sem reconverter, sem perda). */
export function extractAudio(
  input: Uint8Array,
  ext: string,
  target: string,
  onStage: (stage: Stage, progress: number) => void,
): Promise<Uint8Array> {
  return withInput(input, ext, onStage, async (ff, src) => {
    const out = `audio.${target}`;
    try {
      await run(ff, ["-i", src, "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", "copy", out], (p) =>
        onStage("extraindo áudio", p),
      );
      return (await ff.readFile(out)) as Uint8Array;
    } finally {
      await ff.deleteFile(out).catch(() => {});
    }
  });
}

/**
 * Versão leve: Opus 160 kbps pelo codificador nativo do navegador (WebCodecs).
 * O libopus do ffmpeg.wasm trava, então o FFmpeg só decodifica para PCM 48 kHz.
 * Sem WebCodecs, usa AAC 192 kbps do próprio FFmpeg.
 */
async function makeLight(ff: FFmpeg, src: string, onProgress: (p: number) => void) {
  const support =
    typeof AudioEncoder === "undefined"
      ? null
      : await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 160_000 }).catch(() => null);
  if (!support?.supported) {
    await run(ff, ["-i", src, "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "aac", "-b:a", "192k", "out.m4a"], onProgress);
    return { data: (await ff.readFile("out.m4a")) as Uint8Array, mime: "audio/mp4" };
  }
  await run(ff, ["-i", src, "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-f", "f32le", "-c:a", "pcm_f32le", "pcm.f32"], (p) =>
    onProgress(p * 0.3),
  );
  const raw = (await ff.readFile("pcm.f32")) as Uint8Array;
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return { data: await encodeOpus(pcm, (p) => onProgress(0.3 + p * 0.7)), mime: "audio/webm; codecs=opus" };
}

async function encodeOpus(interleaved: Float32Array, onProgress: (p: number) => void): Promise<Uint8Array> {
  const rate = 48000;
  const channels = 2;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: "A_OPUS", sampleRate: rate, numberOfChannels: channels },
  });
  let failure: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure({ codec: "opus", sampleRate: rate, numberOfChannels: channels, bitrate: 160_000 });
  const frames = interleaved.length / channels;
  const block = rate; // 1 s por vez
  for (let start = 0; start < frames; start += block) {
    const n = Math.min(block, frames - start);
    const data = new AudioData({
      format: "f32",
      sampleRate: rate,
      numberOfChannels: channels,
      numberOfFrames: n,
      timestamp: Math.round((start / rate) * 1e6),
      data: interleaved.slice(start * channels, (start + n) * channels),
    });
    encoder.encode(data);
    data.close();
    // Não deixa a fila do codificador crescer sem limite.
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    onProgress(start / frames);
    if (failure) throw failure;
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
