/**
 * Decide o que fazer com um arquivo importado, sem nunca perder qualidade:
 * - "keep":       comum e leve (MP3, AAC, Vorbis, Opus) → fica exatamente como está;
 * - "lossless":   sem perda e pesado (WAV, AIFF, ALAC, APE, WavPack…) → FLAC verificado bit a bit + versão leve;
 * - "dsd":        DSD (DSF/DFF), enorme → FLAC 24-bit/176,4 kHz + versão leve (conversão padrão DSD→PCM);
 * - "keep+light": com perda, mas incomum/pesado ou que o navegador não toca (WMA, AC3, DTS…)
 *                 → original guardado intacto + versão leve tocável;
 * - "extract":    vídeo → separa o áudio sem reconverter e decide de novo.
 */
export type ImportPlan = "keep" | "lossless" | "dsd" | "keep+light" | "extract";

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|3gp|ts|mts|m2ts)$/i;
const DSD = /\bdsd\b|dsf|dsdiff/i;
const DSD_EXT = /\.(dsf|dff)$/i;
const LOSSLESS_CODECS = /pcm|flac|alac|wavpack|monkey|\bape\b|tta|aiff|wave|lpcm|mlp|truehd|shorten/i;
const LOSSLESS_EXT = /\.(wav|wave|w64|aif|aiff|aifc|flac|wv|ape|tta|caf)$/i;
/** Com perda, leves e tocáveis em qualquer navegador moderno. */
const COMMON_LOSSY = /layer\s*3|\bmp3\b|aac|vorbis|opus/i;
const COMMON_EXT = /\.(mp3|m4a|aac|ogg|oga|opus)$/i;

export interface FormatInfo {
  codec?: string;
  container?: string;
  lossless?: boolean;
  hasVideo?: boolean;
}

export function planImport(fileName: string, meta: FormatInfo): ImportPlan {
  const desc = `${meta.codec ?? ""} ${meta.container ?? ""}`;
  if (meta.hasVideo || VIDEO_EXT.test(fileName)) return "extract";
  if (DSD.test(desc) || DSD_EXT.test(fileName)) return "dsd";
  if (meta.lossless === true) return "lossless";
  if (meta.lossless === undefined && (LOSSLESS_CODECS.test(desc) || (!meta.codec && LOSSLESS_EXT.test(fileName)))) {
    return "lossless";
  }
  if (meta.codec ? COMMON_LOSSY.test(meta.codec) : COMMON_EXT.test(fileName)) return "keep";
  // Com perda incomum (WMA, AC3, DTS, MP2…) ou desconhecido: guarda o original e cria uma versão tocável.
  return "keep+light";
}

/** Contêiner para extrair o áudio de um vídeo sem reconverter (stream copy). */
export function extractTarget(codec: string | undefined): { ext: string; mime: string } {
  const c = codec ?? "";
  if (/aac/i.test(c)) return { ext: "m4a", mime: "audio/mp4" };
  if (/layer\s*3|\bmp3\b/i.test(c)) return { ext: "mp3", mime: "audio/mpeg" };
  if (/opus/i.test(c)) return { ext: "opus", mime: "audio/ogg" };
  if (/vorbis/i.test(c)) return { ext: "ogg", mime: "audio/ogg" };
  if (/flac/i.test(c)) return { ext: "flac", mime: "audio/flac" };
  // Qualquer outro codec cabe no Matroska de áudio.
  return { ext: "mka", mime: "audio/x-matroska" };
}

export function describeSource(meta: {
  codec?: string;
  container?: string;
  bitsPerSample?: number;
  sampleRate?: number;
  bitrate?: number;
  lossless?: boolean;
}): string {
  const parts = [meta.codec || meta.container || "?"];
  if (meta.bitsPerSample) parts.push(`${meta.bitsPerSample}-bit`);
  if (meta.sampleRate) parts.push(`${+(meta.sampleRate / 1000).toFixed(1)} kHz`);
  if (!meta.lossless && meta.bitrate) parts.push(`${Math.round(meta.bitrate / 1000)} kbps`);
  return parts.join(" · ");
}
