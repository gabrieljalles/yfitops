import type { FileKey } from "./crypto";

// ---------- Conteúdo dos itens (sempre criptografado no servidor) ----------

export type Variant = "flac" | "opus" | "orig";

export interface BlobRef extends FileKey {
  /** ID do blob no R2 (HMAC do conteúdo). */
  id: string;
  /** Dono do blob (para músicas recebidas por compartilhamento). */
  owner?: string;
  size: number;
  mime: string;
}

export interface Track {
  title: string;
  artist: string;
  album: string;
  genre: string;
  year?: number;
  tags: string[];
  duration: number;
  /** Informação técnica do arquivo de origem, ex.: "FLAC 24-bit 96 kHz". */
  sourceInfo: string;
  /** "flac" = lossless; "orig" = original mantido sem reencode; "opus" = versão leve. */
  variants: Partial<Record<Variant, BlobRef>>;
  cover?: BlobRef;
  /** De onde veio, quando importado de fora. Ex.: "youtube:dQw4w9WgXcQ". Evita baixar de novo. */
  source?: string;
  addedAt: number;
}

export interface Playlist {
  name: string;
  trackIds: string[];
  createdAt: number;
  /** De onde veio, quando importada. Ex.: "youtube-playlist:PL...", "spotify-playlist:37i9...". */
  source?: string;
}

export interface Play {
  trackId: string;
  at: number;
}

export type ItemKind = "track" | "playlist" | "play";

export interface ItemValue {
  track: Track;
  playlist: Playlist;
  play: Play;
}

// ---------- Protocolo HTTP ----------

export interface SyncItem {
  id: string;
  kind: ItemKind;
  enc: string | null;
  version: number;
  deleted: boolean;
  seq: number;
}

export interface SyncPullResponse {
  items: SyncItem[];
  cursor: number;
  more: boolean;
}

export interface SyncPushItem {
  id: string;
  kind: ItemKind;
  enc: string | null;
  deleted: boolean;
}

export interface SignupRequest {
  email: string;
  authKey: string;
  /** Código de 6 dígitos recebido por e-mail. */
  code: string;
  /** Chave mestra cifrada com a senha. */
  wrappedMasterKey: string;
  /** Chave mestra cifrada para a chave de escrow do servidor (recuperação por e-mail). */
  escrowMasterKey: string;
  publicKey: string;
  /** Chave privada de compartilhamento cifrada com a chave enc do usuário. */
  wrappedPrivateKey: string;
}

export interface SessionResponse {
  token: string;
  userId: string;
  email: string;
  wrappedMasterKey: string;
  wrappedPrivateKey: string;
  publicKey: string;
}

/** Conteúdo de um compartilhamento (cifrado para a chave pública do destinatário). */
export interface SharePayload {
  playlist: Playlist;
  tracks: Record<string, Track>;
}

export interface ShareInfo {
  id: string;
  fromUser: string;
  fromEmail: string;
  toUser: string;
  toEmail: string;
  payload: string;
  updatedAt: number;
}
