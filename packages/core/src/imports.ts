import type { SongInfo } from "./catalog";

// ---------------------------------------------------------------------------
// Fila de importação por link (YouTube, Spotify, Deezer).
//
// Quem pede só manda o link. Um celular Android com o app (APK) aberto, ou
// tocando música, e no Wi-Fi, lê o link, baixa cada música e envia ao catálogo.
// Só quem pediu recebe as músicas na biblioteca.
// ---------------------------------------------------------------------------

/** Uma faixa lida de um link (antes de baixar). */
export interface ResolvedTrack {
  /** Vazio nas do Spotify/Deezer até serem procuradas no YouTube. */
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  /** Só nas do Spotify/Deezer: o texto procurado no YouTube. */
  query?: string;
  album?: string;
  /** Capa vinda do Spotify/Deezer. */
  cover?: string;
  spotifyId?: string;
  deezerId?: string;
}

/** Resultado da busca pelo nome da música (GET /search/tracks). Pedir = mandar `url` para a fila. */
export interface TrackSearchHit {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** Segundos. */
  duration: number;
  cover: string | null;
  /** Link da música no Deezer: vira um pedido normal (o celular acha no YouTube e baixa). */
  url: string;
  /** Tem prévia de 30 segundos (pedida na hora em /discover/preview: o link do Deezer expira). */
  preview?: boolean;
}

/** Uma lista pronta do Descobrir (parada do Deezer). */
export interface DiscoverList {
  key: string;
  name: string;
}

/** "Porque você ouve X": as mais famosas do artista e artistas parecidos. */
export interface DiscoverArtist {
  artist: string;
  tracks: TrackSearchHit[];
  related: string[];
}

/** Escolhas de quem pediu. */
export interface ImportOpts {
  tags?: string[];
  /** Se o link for de uma playlist: as músicas ficam ligadas a uma playlist no app. */
  playlist?: boolean;
}

export type ImportTrackStatus = "queued" | "working" | "done" | "failed" | "skipped";

/** Músicas com mais que isto (13 minutos) não entram no yfitops: o celular baixa, mas não envia. */
export const MAX_SONG_SECONDS = 13 * 60;
/** Motivo gravado na música ignorada por ser longa demais. */
export const TOO_LONG = "tem mais de 13 minutos: não entra no yfitops";
/** Longa demais, mas baixada pelo celular de quem pediu: ficou só nele. */
export const TOO_LONG_LOCAL = "tem mais de 13 minutos: ficou só no celular que baixou";

export interface ImportTrackInfo {
  id: string;
  pos: number;
  meta: ResolvedTrack;
  status: ImportTrackStatus;
  error?: string;
  /** A música no catálogo (quando terminou). */
  song?: SongInfo;
  delivered: boolean;
  /** Baixando: quanto já andou (0 a 100), contado pelo celular que baixa. */
  progress?: number;
}

export interface ImportRequestInfo {
  id: string;
  url: string;
  opts: ImportOpts;
  /** queued = esperando um celular ler o link; listing = lendo; listed = músicas na fila; failed. */
  status: "queued" | "listing" | "listed" | "failed";
  provider?: string;
  /** Origem da playlist ("youtube-playlist:<id>"), quando o link era de uma. */
  source?: string;
  name?: string;
  truncated: boolean;
  error?: string;
  createdAt: number;
  tracks: ImportTrackInfo[];
}

/** O que o servidor entrega a um celular que pede trabalho. */
export type SpotJob =
  | { type: "list"; id: string; url: string }
  /** `mine`: o pedido é de quem está com este celular (aí uma música longa fica nele). */
  | { type: "track"; id: string; requestId: string; meta: ResolvedTrack; mine: boolean };

/** Tipo da falha: "limit" = o YouTube barrou este celular (descansa); "gone" = não existe; "temp" = passageira. */
export type SpotFailKind = "limit" | "gone" | "temp";

/** Hosts aceitos nos links pedidos. */
export const IMPORT_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com|spotify\.link|deezer\.com|deezer\.page\.link|dzr\.page\.link)$/i;
