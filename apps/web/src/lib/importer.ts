import { parseBuffer, type IAudioMetadata } from "music-metadata";
import { contentId, describeSource, extractTarget, planImport, type BlobRef, type Track } from "@yfitops/core";
import { uploadBlob } from "./blobs";
import { extractAudio, lightOnly, transcodeDsd, transcodeLossless, type Stage } from "./ffmpeg";
import { formatBytes } from "./tracks";
import { libraryStore, saveItem } from "./library";
import { createStore } from "./observable";
import { getKeys } from "./session";

export type JobStatus = "na fila" | "lendo" | "convertendo" | "enviando" | "pronto" | "já existe" | "erro";

export interface Job {
  id: number;
  name: string;
  size: number;
  status: JobStatus;
  detail: string;
  progress: number;
  result?: string;
}

export const jobsStore = createStore<Job[]>([]);
let nextId = 1;
const queue: { job: Job; file: File }[] = [];
let busy = false;

function update(id: number, patch: Partial<Job>) {
  jobsStore.set((jobs) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));
}

/** Extensões aceitas (além de qualquer audio/* ou video/*). */
export const ACCEPTED_EXT =
  /\.(mp3|mp2|m4a|aac|ogg|oga|opus|flac|wav|w64|aif|aiff|aifc|caf|alac|wv|ape|tta|wma|ac3|eac3|dts|amr|mpc|dsf|dff|mka|mp4|m4v|mov|mkv|webm|avi|flv|wmv|3gp|ts|mts|m2ts)$/i;

export function enqueue(files: File[]) {
  const audio = files.filter((f) => /^(audio|video)\//.test(f.type) || ACCEPTED_EXT.test(f.name));
  for (const file of audio) {
    const job: Job = { id: nextId++, name: file.name, size: file.size, status: "na fila", detail: "", progress: 0 };
    jobsStore.set((j) => [...j, job]);
    queue.push({ job, file });
  }
  void drain();
}

export function clearFinished() {
  jobsStore.set((jobs) => jobs.filter((j) => !["pronto", "já existe", "erro"].includes(j.status)));
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const { job, file } = queue.shift()!;
      try {
        await importFile(job.id, file);
      } catch (e) {
        console.error(`Falha ao importar ${file.name}`, e);
        update(job.id, { status: "erro", detail: (e as Error)?.message || String(e) });
      }
    }
  } finally {
    busy = false;
  }
}

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  mp2: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  wma: "audio/x-ms-wma",
  ac3: "audio/ac3",
  dts: "audio/vnd.dts",
  mka: "audio/x-matroska",
  dsf: "audio/dsf",
  dff: "audio/dff",
};

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const mimeOf = (name: string, given?: string) => given || MIME[extOf(name)] || "application/octet-stream";

function titleFromName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/^\d+[\s.\-_]+/, "").trim();
}

type Meta = Pick<IAudioMetadata, "format" | "common">;

const META_TIMEOUT = 15000;
const emptyMeta = (): Meta => ({ format: {} as IAudioMetadata["format"], common: {} as IAudioMetadata["common"] });

/**
 * Lê tags e formato. Usa o arquivo já carregado na memória (acesso aleatório: o índice de um MP4
 * pode estar no fim) e desiste após 15 s — tags são opcionais, o FFmpeg cuida do resto.
 * Formatos que o leitor não conhece seguem sem metadados.
 */
async function readMeta(data: Uint8Array, mimeType: string): Promise<Meta> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      parseBuffer(data, { mimeType, size: data.length }, { duration: true, skipCovers: false }),
      new Promise<Meta>((resolve) => {
        timer = setTimeout(() => {
          console.warn("Leitura de tags demorou demais; seguindo sem elas");
          resolve(emptyMeta());
        }, META_TIMEOUT);
      }),
    ]);
  } catch {
    return emptyMeta();
  } finally {
    clearTimeout(timer);
  }
}

/** Duração pelo próprio navegador, quando as tags não trazem. */
function probeDuration(data: Uint8Array, mime: string): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([data], { type: mime.split(";")[0] }));
    const a = new Audio();
    const done = (d: number) => (URL.revokeObjectURL(url), resolve(isFinite(d) ? d : 0));
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

type Upload = { key: "flac" | "opus" | "orig"; data: Uint8Array; mime: string };

async function importFile(jobId: number, file: File) {
  update(jobId, { status: "lendo" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const trackId = await contentId(getKeys(), bytes);
  if (libraryStore.get().tracks[trackId]) {
    update(jobId, { status: "já existe", detail: "Essa música já está na biblioteca", result: trackId });
    return;
  }

  const meta = await readMeta(bytes, mimeOf(file.name, file.type));
  let f = meta.format;
  let src = bytes;
  let srcName = file.name;
  let srcMime = mimeOf(file.name, file.type);
  let plan = planImport(file.name, { codec: f.codec, container: f.container, lossless: f.lossless, hasVideo: file.type.startsWith("video/") });
  const onStage = (stage: Stage, p: number) => update(jobId, { detail: stage, progress: p });
  const notes: string[] = [];

  // Vídeo: separa o áudio sem reconverter e decide de novo com base nele.
  if (plan === "extract") {
    update(jobId, { status: "convertendo" });
    const target = extractTarget(f.codec);
    src = await extractAudio(bytes, extOf(file.name), target.ext, onStage);
    srcName = `audio.${target.ext}`;
    srcMime = target.mime;
    f = (await readMeta(src, target.mime)).format;
    plan = planImport(srcName, { codec: f.codec, container: f.container, lossless: f.lossless });
    if (plan === "extract") plan = "keep+light";
    notes.push(`áudio do vídeo (${formatBytes(file.size)} → ${formatBytes(src.length)})`);
  }

  const toUpload: Upload[] = [];
  const original: Upload = { key: "orig", data: src, mime: srcMime };
  if (plan === "lossless") {
    update(jobId, { status: "convertendo" });
    const res = await transcodeLossless(src, extOf(srcName), onStage);
    toUpload.push(res.flac ? { key: "flac", data: res.flac, mime: "audio/flac" } : original);
    toUpload.push({ key: "opus", data: res.light.data, mime: res.light.mime });
    notes.push(res.flac ? `FLAC ${pct(res.flac.length, src.length)}` : "original mantido (verificação não bateu)");
  } else if (plan === "dsd") {
    update(jobId, { status: "convertendo" });
    const res = await transcodeDsd(src, extOf(srcName), onStage);
    toUpload.push({ key: "flac", data: res.flac, mime: "audio/flac" });
    toUpload.push({ key: "opus", data: res.light.data, mime: res.light.mime });
    notes.push(`DSD → FLAC 24-bit/176,4 kHz, ${pct(res.flac.length, src.length)}`);
  } else if (plan === "keep+light") {
    // Com perda e incomum: o original fica intacto (reconverter pioraria) e ganha uma versão tocável.
    update(jobId, { status: "convertendo" });
    const light = await lightOnly(src, extOf(srcName), onStage);
    toUpload.push(original, { key: "opus", data: light.data, mime: light.mime });
    notes.push("original guardado + versão tocável");
  } else {
    // Comum e leve: fica exatamente como está.
    toUpload.push(original);
    notes.push("mantido como está");
  }

  update(jobId, { status: "enviando", progress: 0 });
  const variants: Track["variants"] = {};
  const total = toUpload.reduce((n, u) => n + u.data.length, 0);
  let done = 0;
  for (const u of toUpload) {
    variants[u.key] = await uploadBlob(u.data, u.mime, (p) =>
      update(jobId, { detail: u.key.toUpperCase(), progress: (done + p * u.data.length) / total }),
    );
    done += u.data.length;
  }

  let cover: BlobRef | undefined;
  const pic = meta.common.picture?.[0];
  if (pic) {
    try {
      cover = await uploadBlob(await makeCover(new Blob([pic.data], { type: pic.format })), "image/webp");
    } catch {
      /* capa ilegível: usa o vinil */
    }
  }

  const playable = toUpload.find((u) => u.key === "opus") ?? toUpload[0];
  const c = meta.common;
  const track: Track = {
    title: c.title || titleFromName(file.name),
    artist: c.artist || c.albumartist || "",
    album: c.album || "",
    genre: c.genre?.[0] || "",
    year: c.year,
    tags: [],
    duration: f.duration || meta.format.duration || (await probeDuration(playable.data, playable.mime)),
    sourceInfo: describeSource(meta.format.codec ? meta.format : f) || extOf(file.name).toUpperCase(),
    variants,
    cover,
    addedAt: Date.now(),
  };
  await saveItem("track", trackId, track);
  update(jobId, { status: "pronto", progress: 1, detail: notes.join(" · "), result: trackId });
}
const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}% do tamanho`;

/** Textura de capa de disco gasta (PNG branco com transparência), aplicada por cima de toda capa. */
const COVER_TEXTURE = "/textura_vinil_branca.png";
export const COVER_SIZE = 300;
export const COVER_QUALITY = 0.65;

let texture: Promise<ImageBitmap | null> | null = null;
function loadTexture(): Promise<ImageBitmap | null> {
  texture ??= fetch(COVER_TEXTURE)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => createImageBitmap(b))
    .catch((e) => {
      console.warn("Textura da capa indisponível; seguindo sem ela", e);
      texture = null; // tenta de novo na próxima capa
      return null;
    });
  return texture;
}

/**
 * Transforma qualquer imagem numa capa leve:
 * 1. recorta um quadrado pelo centro (corta do lado maior: laterais se for larga, topo/base se for alta);
 * 2. aplica a textura de vinil por cima;
 * 3. salva em WebP pequeno (300×300).
 */
export async function makeCover(image: Blob, size = COVER_SIZE, quality = COVER_QUALITY): Promise<Uint8Array> {
  const [bmp, tex] = await Promise.all([createImageBitmap(image), loadTexture()]);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close();
  if (tex) ctx.drawImage(tex, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", quality));
  if (!blob) throw new Error("Não foi possível gerar a capa");
  return new Uint8Array(await blob.arrayBuffer());
}
