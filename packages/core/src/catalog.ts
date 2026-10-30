// ---------- Catálogo compartilhado ----------
// Cada música existe uma vez só na nuvem (MP3, sem criptografia) e as
// bibliotecas de todos apontam para ela. Duas músicas são "a mesma" quando o
// artista principal e o título normalizados batem E a duração é parecida.

/** Diferença máxima de duração (s) para duas gravações serem a mesma música. */
export const MATCH_TOLERANCE = 3;

/** Música do catálogo, como o servidor devolve. */
export interface SongInfo {
  id: string;
  artist: string;
  title: string;
  album: string;
  duration: number;
  size: number;
  /** 0 = sem capa. */
  coverSize: number;
  /** Formato do áudio: "audio/mpeg" (MP3) ou "audio/mp4" (M4A). Ausente = MP3. */
  mime?: string;
}

/** O que identifica uma música ao procurar no catálogo antes de enviar/baixar. */
export interface SongQuery {
  artist: string;
  title: string;
  duration: number;
  /** SHA-256 (base64url) do arquivo original, para achar o mesmo arquivo exato. */
  hash?: string;
  /** Origens exatas: "youtube:<id>", "spotify:<id>", "deezer:<id>". */
  sources?: string[];
}

/** Marcas de versão: "ao vivo" e "estúdio" são músicas diferentes, e nunca se juntam. */
const VERSION_MARKERS: [RegExp, string][] = [
  [/\b(live|ao vivo|en vivo|en directo)\b/, "live"],
  [/\b(acoustic|acustico|acustica|unplugged)\b/, "acoustic"],
  [/\b(remix|rmx|mix)\b/, "remix"],
  [/\bremaster(ed)?\b|\bremasterizad[oa]\b/, "remaster"],
  [/\bcover\b/, "cover"],
  [/\binstrumental\b/, "instrumental"],
  [/\b(karaoke|playback)\b/, "karaoke"],
  [/\bsped ?up\b|\bacelerad[oa]\b/, "spedup"],
  [/\bslowed\b|\breverb\b/, "slowed"],
  [/\bnightcore\b/, "nightcore"],
  [/\b(radio edit|edit)\b/, "edit"],
  [/\b(extended|estendid[oa])\b/, "extended"],
  [/\bdemo\b/, "demo"],
  [/\b(8d|8 d)\b/, "8d"],
];

/** Enfeites de vídeo que não mudam a música. */
const NOISE =
  /\b(official|oficial|music|musical|video|videoclipe|clipe|clip|audio|lyrics?|letra|legendado|visualizer|hd|hq|4k|mv|full|versao|version|com|with|from)\b/g;

/** minúsculas, sem acentos, só letras/números/espaços. */
export function plain(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " e ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Artista principal: "Anitta feat. X", "A & B", "A e B", "A, B" → o primeiro.
 * (Duplas viram só o primeiro nome, dos dois lados: a comparação continua valendo.)
 */
export function mainArtist(artist: string): string {
  const first = (artist ?? "")
    .split(/\s*(?:,|;|\/|&|\+|\bx\b|\be\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bcom\b|\bwith\b)\s*/i)[0]
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "");
  return plain(first).replace(/^the /, "") || plain(artist);
}

/**
 * Título normalizado + marcas de versão. "Evidências (Ao Vivo) [Official Video]"
 * e "Evidências - Ao Vivo" viram o mesmo; "Evidências" (estúdio) não.
 */
export function titleKey(title: string): string {
  let base = title ?? "";
  const extras: string[] = [];
  // Partes entre parênteses/colchetes e depois de " - ": versão ou enfeite.
  base = base.replace(/[([{]([^)\]}]*)[)\]}]/g, (_, inner: string) => (extras.push(inner), " "));
  const dash = base.split(/\s+[-–—|]\s+/);
  base = dash[0];
  extras.push(...dash.slice(1));
  base = base.replace(/\b(feat|ft|featuring)\b.*$/i, "");

  const markers = new Set<string>();
  for (const e of extras.map(plain)) {
    if (/^(feat|ft|featuring|with|com)\b/.test(e)) continue;
    let found = false;
    for (const [re, tag] of VERSION_MARKERS) {
      if (!re.test(e)) continue;
      found = true;
      // Remix de quem? "Alok Remix" e "Vintage Culture Remix" são músicas diferentes.
      markers.add(tag === "remix" ? e.replace(NOISE, "").replace(/\s+/g, " ").trim() : tag);
    }
    // Nem versão nem enfeite (ex.: "(Parte 2)"): faz parte do título.
    if (!found && e.replace(NOISE, "").trim()) base += ` ${e}`;
  }
  return [plain(base), ...[...markers].sort()].join("|");
}

/** Chave de comparação: "artista|título|marcas". */
export function matchKey(artist: string, title: string): string {
  return `${mainArtist(artist)}|${titleKey(title)}`;
}

/** Texto de busca do catálogo (sem acentos, minúsculo). */
export function searchText(...parts: string[]): string {
  return parts.map(plain).filter(Boolean).join(" ");
}
