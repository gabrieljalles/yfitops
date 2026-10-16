import { parseBuffer, type IAudioMetadata } from "music-metadata";
import { describeSource } from "@yfitops/core";
import { lookupArtist, splitArtistTitle, UNKNOWN_ARTIST } from "./artist";
import { addSong, audioRef, coverRef, fileHash, findInCatalog, publishSong } from "./catalog";
import { rememberLocal } from "./blobs";
import { notify } from "./notify";
import { refreshUsage } from "./usage";
import { MP3_KBPS, toMp3, type Stage } from "./ffmpeg";
import { formatBytes } from "./tracks";
import { libraryStore } from "./library";
import { createStore } from "./observable";

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
  /**
   * Só envia ao catálogo, sem pôr na biblioteca deste aparelho (celular baixando
   * para a fila de outra pessoa). O `result` do job vira o id da música no catálogo.
   */
  publishOnly?: boolean;
}

type Report = (patch: Partial<Job>) => void;

/** Um arquivo por vez no FFmpeg (envios da pessoa e downloads da fila dividem o mesmo). */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = lock.then(work, work);
  lock = run.catch(() => {});
  return run;
}

/**
 * Para a fila de importação: converte e envia ao catálogo SEM pôr na biblioteca
 * deste aparelho. Devolve o id da música no catálogo.
 */
export async function publishForQueue(file: File, extras: ImportExtras, onStatus?: (status: string) => void): Promise<string> {
  let result = "";
  await exclusive(() =>
    importFile(file, { ...extras, publishOnly: true }, (patch) => {
      if (patch.result) result = patch.result;
      if (patch.status) onStatus?.(patch.status);
    }),
  );
  if (!result) throw new Error("A música não chegou ao catálogo");
  return result;
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
        await exclusive(() => importFile(file, extras, (patch) => update(job.id, patch)));
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

/** MP3 até este bitrate entra como está (só sem as tags): reconverter só piora. */
const KEEP_MP3_UP_TO = 200_000;

/** "já existe": a faixa já estava na biblioteca, com as tags e origens novas aplicadas. */
async function linkExisting(report: Report, song: Parameters<typeof addSong>[0], extras: ImportExtras, sourceInfo?: string) {
  if (extras.publishOnly) return report({ status: "pronto", detail: sourceInfo ?? "pronto", result: song.id, progress: 1 });
  const { id, existed } = await addSong(song, {
    tags: extras.tags,
    source: extras.source,
    alsoFrom: extras.alsoFrom,
    sourceInfo,
  });
  report(existed
    ? { status: "já existe", detail: "Essa música já está na biblioteca", result: id, progress: 1 }
    : { status: "pronto", detail: sourceInfo ?? "pronto", result: id, progress: 1 });
}

async function importFile(file: File, extras: ImportExtras, report: Report) {
  report({ status: "lendo" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = mimeOf(file.name, file.type);
  const [meta, hash] = await Promise.all([readMeta(bytes, mime), fileHash(bytes)]);
  const f = meta.format;
  const c = meta.common;

  // Sem tags: o nome do arquivo costuma ser "Artista - Título".
  const fromName = c.title || extras.title ? null : splitArtistTitle(titleFromName(file.name));
  const title = c.title || extras.title || fromName?.title || titleFromName(file.name);
  let artist = c.artist || c.albumartist || extras.artist || fromName?.artist || "";
  if (!artist) {
    report({ detail: "procurando o artista..." });
    artist = (await lookupArtist(title)) || UNKNOWN_ARTIST;
  }
  const duration = f.duration || (await probeDuration(bytes, mime));
  const sources = [extras.source, ...(extras.alsoFrom ?? [])].filter((x): x is string => !!x);
  const sourceInfo = describeSource(f) || extOf(file.name).toUpperCase();

  // Alguém (talvez você) já enviou essa música: só liga na biblioteca.
  const query = { artist, title, duration, hash, sources };
  const known = await findInCatalog(query);
  if (known) return linkExisting(report, known, extras, sourceInfo);

  report({ status: "convertendo" });
  const onStage = (stage: Stage, p: number) => report({ detail: stage, progress: p });
  const lightMp3 = /layer 3/i.test(f.codec ?? "") && !!f.bitrate && f.bitrate <= KEEP_MP3_UP_TO;
  const audio = await toMp3(bytes, extOf(file.name), onStage, lightMp3);
  const note = lightMp3
    ? "MP3 mantido como está"
    : `${sourceInfo} → MP3 ${MP3_KBPS} kbps (${formatBytes(file.size)} → ${formatBytes(audio.length)})`;

  let cover: Uint8Array | undefined;
  const pic = c.picture?.[0];
  const image = pic ? new Blob([pic.data], { type: pic.format }) : extras.cover;
  if (image) {
    try {
      cover = await makeCover(image);
    } catch {
      /* capa ilegível: usa o vinil */
    }
  }

  report({ status: "enviando", detail: "", progress: 0 });
  const { song, created } = await publishSong(
    audio,
    cover,
    { ...query, duration: duration || (await probeDuration(audio, "audio/mpeg")), album: c.album || extras.album || "" },
    (p) => report({ progress: p }),
  );
  // Outra pessoa enviou a mesma enquanto este aparelho convertia.
  if (!created) return linkExisting(report, song, extras, sourceInfo);
  if (extras.publishOnly) return report({ status: "pronto", progress: 1, detail: note, result: song.id });
  // Este aparelho já tem o MP3 e a capa: tocar não precisa baixar de volta.
  await rememberLocal(audioRef(song), audio).catch(() => {});
  const cref = coverRef(song);
  if (cref && cover) await rememberLocal(cref, cover).catch(() => {});

  const { id } = await addSong(song, {
    tags: extras.tags,
    source: extras.source,
    alsoFrom: extras.alsoFrom,
    genre: c.genre?.[0],
    year: c.year,
    sourceInfo,
  });
  report({ status: "pronto", progress: 1, detail: note, result: id });
}

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
