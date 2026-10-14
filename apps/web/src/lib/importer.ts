import { parseBuffer, type IAudioMetadata } from "music-metadata";
import {
  contentId,
  describeSource,
  extractTarget,
  planImport,
  type BlobRef,
  type Track,
} from "@yfitops/core";
import { lookupArtist, splitArtistTitle, UNKNOWN_ARTIST } from "./artist";
import { notify } from "./notify";
import { refreshUsage } from "./usage";
import { mergeTags } from "./search";
import { uploadBlob } from "./blobs";
import {
  extractAudio,
  lightOnly,
  transcodeDsd,
  transcodeLossless,
  type Stage,
} from "./ffmpeg";
import { formatBytes } from "./tracks";
import { libraryStore, saveItem } from "./library";
import { createStore } from "./observable";
import { getKeys } from "./session";

export type JobStatus =
  | "na fila"
  | "lendo"
  | "convertendo"
  | "enviando"
  | "pronto"
  | "já existe"
  | "erro";

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
/** Extras de uma importação vinda de fora (ex.: YouTube). */
export interface ImportExtras {
  /** Imagem para virar capa quando o arquivo não tiver uma embutida (ex.: thumbnail do vídeo). */
  cover?: Blob;
  /** Origem, gravada na faixa para não baixar de novo. Ex.: "youtube:<id>". */
  source?: string;
  /** Dados da origem (Spotify/YouTube), usados quando o arquivo não traz tags. */
  title?: string;
  artist?: string;
  album?: string;
  /** Tags escolhidas antes de importar, aplicadas a todas (inclusive às que já existiam). */
  tags?: string[];
  /** Origem no catálogo (ex.: "spotify:<id>"), para não procurar no YouTube de novo. */
  alsoFrom?: string[];
}

const queue: {
  job: Job;
  file: File;
  extras: ImportExtras;
  done: (job: Job) => void;
}[] = [];
let busy = false;

function update(id: number, patch: Partial<Job>) {
  jobsStore.set((jobs) =>
    jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
  );
}

/** Extensões aceitas (além de qualquer audio/* ou video/*). */
export const ACCEPTED_EXT =
  /\.(mp3|mp2|m4a|aac|ogg|oga|opus|flac|wav|w64|aif|aiff|aifc|caf|alac|wv|ape|tta|wma|ac3|eac3|dts|amr|mpc|dsf|dff|mka|mp4|m4v|mov|mkv|webm|avi|flv|wmv|3gp|ts|mts|m2ts)$/i;

/**
 * Põe arquivos na fila de importação.
 * Devolve uma promessa por arquivo aceito, que resolve com o job já terminado
 * ("pronto", "já existe" ou "erro").
 */
export function enqueue(
  files: File[],
  extras: ImportExtras = {},
): Promise<Job>[] {
  const audio = files.filter(
    (f) => /^(audio|video)\//.test(f.type) || ACCEPTED_EXT.test(f.name),
  );
  const finished: Promise<Job>[] = [];
  for (const file of audio) {
    const job: Job = {
      id: nextId++,
      name: file.name,
      size: file.size,
      status: "na fila",
      detail: "",
      progress: 0,
    };
    jobsStore.set((j) => [...j, job]);
    finished.push(
      new Promise((done) => queue.push({ job, file, extras, done })),
    );
  }
  void drain();
  return finished;
}

/** Id da faixa já importada com essa origem (ex.: "youtube:<id>"), se houver. */
export function trackIdBySource(source: string): string | undefined {
  const tracks = libraryStore.get().tracks;
  return Object.keys(tracks).find((id) => tracks[id].source === source);
}

export function clearFinished() {
  jobsStore.set((jobs) =>
    jobs.filter((j) => !["pronto", "já existe", "erro"].includes(j.status)),
  );
}

async function drain() {
  if (busy) return;
  busy = true;
  /** Arquivos enviados pela pessoa nesta rodada (os da importação por link avisam por conta própria). */
  const sent: number[] = [];
  try {
    while (queue.length) {
      const { job, file, extras, done } = queue.shift()!;
      if (!extras.source) sent.push(job.id);
      try {
        await importFile(job.id, file, extras);
      } catch (e) {
        console.error(`Falha ao importar ${file.name}`, e);
        update(job.id, {
          status: "erro",
          detail: (e as Error)?.message || String(e),
        });
      }
      done(jobsStore.get().find((j) => j.id === job.id) ?? job);
    }
  } finally {
    busy = false;
  }
  // O espaço da nuvem mudou: atualiza a barra (Ajustes e o aviso de nuvem cheia).
  void refreshUsage();
  if (sent.length) {
    const jobs = jobsStore.get().filter((j) => sent.includes(j.id));
    const ok = jobs.filter((j) => j.status === "pronto").length;
    const failed = jobs.filter((j) => j.status === "erro").length;
    void notify(
      failed ? "Envio terminou com erros" : "Envio concluído",
      [ok && `${ok} enviada(s)`, failed && `${failed} com erro`, jobs.length - ok - failed && `${jobs.length - ok - failed} já estavam`]
        .filter(Boolean)
        .join(" · "),
    );
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
const mimeOf = (name: string, given?: string) =>
  given || MIME[extOf(name)] || "application/octet-stream";

function titleFromName(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/^\d+[\s.\-_]+/, "")
    .trim();
}

type Meta = Pick<IAudioMetadata, "format" | "common">;

const META_TIMEOUT = 15000;
const emptyMeta = (): Meta => ({
  format: {} as IAudioMetadata["format"],
  common: {} as IAudioMetadata["common"],
});

/**
 * Lê tags e formato. Usa o arquivo já carregado na memória (acesso aleatório: o índice de um MP4
 * pode estar no fim) e desiste após 15 s — tags são opcionais, o FFmpeg cuida do resto.
 * Formatos que o leitor não conhece seguem sem metadados.
 */
async function readMeta(data: Uint8Array, mimeType: string): Promise<Meta> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      parseBuffer(
        data,
        { mimeType, size: data.length },
        { duration: true, skipCovers: false },
      ),
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
    const url = URL.createObjectURL(
      new Blob([data], { type: mime.split(";")[0] }),
    );
    const a = new Audio();
    const done = (d: number) => (
      URL.revokeObjectURL(url),
      resolve(isFinite(d) ? d : 0)
    );
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

type Upload = { key: "flac" | "opus" | "orig"; data: Uint8Array; mime: string };

async function importFile(jobId: number, file: File, extras: ImportExtras) {
  update(jobId, { status: "lendo" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const trackId = await contentId(getKeys(), bytes);
  const existing = libraryStore.get().tracks[trackId];
  if (existing) {
    // Faixa importada antes de guardarmos a origem: grava agora, para da próxima
    // vez nem baixar. E recebe as tags escolhidas na importação.
    const source = extras.source && !existing.source ? extras.source : undefined;
    const tags = mergeTags(existing.tags, extras.tags);
    const newOrigins = (extras.alsoFrom ?? []).filter((k) => !existing.alsoFrom?.includes(k));
    const alsoFrom = newOrigins.length ? [...(existing.alsoFrom ?? []), ...newOrigins] : existing.alsoFrom;
    if (source || tags !== existing.tags || alsoFrom !== existing.alsoFrom) {
      await saveItem("track", trackId, { ...existing, ...(source && { source }), tags, ...(alsoFrom && { alsoFrom }) });
    }
    update(jobId, {
      status: "já existe",
      detail: "Essa música já está na biblioteca",
      result: trackId,
    });
    return;
  }

  const meta = await readMeta(bytes, mimeOf(file.name, file.type));
  let f = meta.format;
  let src = bytes;
  let srcName = file.name;
  let srcMime = mimeOf(file.name, file.type);
  let plan = planImport(file.name, {
    codec: f.codec,
    container: f.container,
    lossless: f.lossless,
    hasVideo: file.type.startsWith("video/"),
  });
  const onStage = (stage: Stage, p: number) =>
    update(jobId, { detail: stage, progress: p });
  const notes: string[] = [];

  // Vídeo: separa o áudio sem reconverter e decide de novo com base nele.
  if (plan === "extract") {
    update(jobId, { status: "convertendo" });
    const target = extractTarget(f.codec);
    src = await extractAudio(bytes, extOf(file.name), target.ext, onStage);
    srcName = `audio.${target.ext}`;
    srcMime = target.mime;
    f = (await readMeta(src, target.mime)).format;
    plan = planImport(srcName, {
      codec: f.codec,
      container: f.container,
      lossless: f.lossless,
    });
    if (plan === "extract") plan = "keep+light";
    notes.push(
      `áudio do vídeo (${formatBytes(file.size)} → ${formatBytes(src.length)})`,
    );
  }

  const toUpload: Upload[] = [];
  const original: Upload = { key: "orig", data: src, mime: srcMime };
  if (plan === "lossless") {
    update(jobId, { status: "convertendo" });
    const res = await transcodeLossless(src, extOf(srcName), onStage);
    toUpload.push(
      res.flac ? { key: "flac", data: res.flac, mime: "audio/flac" } : original,
    );
    toUpload.push({ key: "opus", data: res.light.data, mime: res.light.mime });
    notes.push(
      res.flac
        ? `FLAC ${pct(res.flac.length, src.length)}`
        : "original mantido (verificação não bateu)",
    );
  } else if (plan === "dsd") {
    update(jobId, { status: "convertendo" });
    const res = await transcodeDsd(src, extOf(srcName), onStage);
    toUpload.push({ key: "flac", data: res.flac, mime: "audio/flac" });
    toUpload.push({ key: "opus", data: res.light.data, mime: res.light.mime });
    notes.push(
      `DSD → FLAC 24-bit/176,4 kHz, ${pct(res.flac.length, src.length)}`,
    );
  } else if (plan === "keep+light") {
    // Com perda e incomum: o original fica intacto (reconverter pioraria) e ganha uma versão tocável.
    update(jobId, { status: "convertendo" });
    const light = await lightOnly(src, extOf(srcName), onStage);
    toUpload.push(original, {
      key: "opus",
      data: light.data,
      mime: light.mime,
    });
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
      update(jobId, {
        detail: u.key.toUpperCase(),
        progress: (done + p * u.data.length) / total,
      }),
    );
    done += u.data.length;
  }

  let cover: BlobRef | undefined;
  const pic = meta.common.picture?.[0];
  const image = pic ? new Blob([pic.data], { type: pic.format }) : extras.cover;
  if (image) {
    try {
      cover = await uploadBlob(await makeCover(image), "image/webp");
    } catch {
      /* capa ilegível: usa o vinil */
    }
  }

  const playable = toUpload.find((u) => u.key === "opus") ?? toUpload[0];
  const c = meta.common;
  // Sem tags: o nome do arquivo costuma ser "Artista - Título".
  const fromName = c.title || extras.title ? null : splitArtistTitle(titleFromName(file.name));
  const title = c.title || extras.title || fromName?.title || titleFromName(file.name);
  let artist = c.artist || c.albumartist || extras.artist || fromName?.artist || "";
  if (!artist) {
    update(jobId, { detail: "procurando o artista..." });
    artist = (await lookupArtist(title)) || UNKNOWN_ARTIST;
  }
  const track: Track = {
    title,
    artist,
    album: c.album || extras.album || "",
    genre: c.genre?.[0] || "",
    year: c.year,
    tags: mergeTags([], extras.tags),
    ...(extras.alsoFrom?.length && { alsoFrom: extras.alsoFrom }),
    duration:
      f.duration ||
      meta.format.duration ||
      (await probeDuration(playable.data, playable.mime)),
    sourceInfo:
      describeSource(meta.format.codec ? meta.format : f) ||
      extOf(file.name).toUpperCase(),
    variants,
    cover,
    ...(extras.source && { source: extras.source }),
    addedAt: Date.now(),
  };
  await saveItem("track", trackId, track);
  update(jobId, {
    status: "pronto",
    progress: 1,
    detail: notes.join(" · "),
    result: trackId,
  });
}
const pct = (a: number, b: number) =>
  `${Math.round((a / b) * 100)}% do tamanho`;

/** Textura de capa de disco gasta (PNG branco com transparência), aplicada por cima de toda capa. */
const COVER_TEXTURE = "/textura_vinil_branca.png";
/** Opacidade da textura sobre a capa (0 = invisível, 1 = PNG original). */
const COVER_TEXTURE_OPACITY = 0.25;
export const COVER_SIZE = 300;
export const COVER_QUALITY = 0.65;

let texture: Promise<ImageBitmap | null> | null = null;
function loadTexture(): Promise<ImageBitmap | null> {
  texture ??= fetch(COVER_TEXTURE)
    .then((r) =>
      r.ok ? r.blob() : Promise.reject(new Error(String(r.status))),
    )
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
export async function makeCover(
  image: Blob,
  size = COVER_SIZE,
  quality = COVER_QUALITY,
): Promise<Uint8Array> {
  const [bmp, tex] = await Promise.all([
    createImageBitmap(image),
    loadTexture(),
  ]);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    bmp,
    (bmp.width - side) / 2,
    (bmp.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bmp.close();
  if (tex) {
    ctx.globalAlpha = COVER_TEXTURE_OPACITY;
    ctx.drawImage(tex, 0, 0, size, size);
    ctx.globalAlpha = 1;
  }
  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, "image/webp", quality),
  );
  if (!blob) throw new Error("Não foi possível gerar a capa");
  return new Uint8Array(await blob.arrayBuffer());
}
