import type { FileKey } from "./crypto";

// ---------- Conteúdo dos itens (sempre criptografado no servidor) ----------

/** "mp3" = música do catálogo compartilhado; as outras são de antes do catálogo. */
export type Variant = "mp3" | "flac" | "opus" | "orig";

/** Arquivo criptografado, só do dono (envios de antes do catálogo e capas trocadas à mão). */
export interface EncryptedRef extends FileKey {
  /** ID do blob no R2 (HMAC do conteúdo). */
  id: string;
  /** Dono do blob (para músicas recebidas por compartilhamento). */
  owner?: string;
  size: number;
  mime: string;
  shared?: undefined;
}

/** Arquivo do catálogo compartilhado (sem criptografia): /api/songs/<id>/<shared>. */
export interface SharedRef {
  /** ID da música no catálogo. */
  id: string;
  shared: "audio" | "cover";
  size: number;
  mime: string;
}

export type BlobRef = EncryptedRef | SharedRef;

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
  /**
   * Outras origens da mesma música nos catálogos (ex.: "spotify:<id>", "deezer:<id>").
   * Ao sincronizar uma playlist, uma faixa já conhecida não é procurada de novo no YouTube.
   */
  alsoFrom?: string[];
  /** Quando foi marcada como favorita (ausente = não é favorita). */
  favoriteAt?: number;
  /** Música do catálogo compartilhado que esta faixa usa. */
  song?: string;
  addedAt: number;
}

export interface Playlist {
  name: string;
  trackIds: string[];
  createdAt: number;
  /** De onde veio, quando importada. Ex.: "youtube-playlist:PL...", "spotify-playlist:37i9...". */
  source?: string;
  /** Link original da importação, para "sincronizar" (baixar só as novas). */
  sourceUrl?: string;
  /** Quando foi sincronizada pela última vez. */
  syncedAt?: number;
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
  /** "pending" = pediu para entrar e espera o administrador aceitar. */
  status: AccountStatus;
  /** Só existe para administradores. */
  admin?: true;
}

export type AccountStatus = "approved" | "pending";

/** GET /auth/me */
export interface AccountInfo {
  status: AccountStatus;
  admin?: true;
  /** Pedidos de acesso esperando (só para administradores). */
  pendingRequests?: number;
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
