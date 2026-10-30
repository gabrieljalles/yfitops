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
  /**
   * Só neste aparelho: passou de 13 minutos, então não foi para o servidor. O
   * arquivo fica nos downloads do aparelho e a faixa não sincroniza com os outros.
   */
  local?: true;
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
  /** Celular para contato (cobrança). */
  phone: string;
  /** Chave mestra cifrada com a senha. */
  wrappedMasterKey: string;
  /** Chave mestra cifrada para a chave de escrow do servidor (recuperação por e-mail). */
  escrowMasterKey: string;
  publicKey: string;
  /** Chave privada de compartilhamento cifrada com a chave enc do usuário. */
  wrappedPrivateKey: string;
  /** Código do link de indicação por onde a pessoa chegou (opcional). */
  ref?: string;
}

/** Cobrança e permissões da conta (no login e em GET /auth/me). */
export interface AccountBilling {
  /** Acesso pago até este instante (ms). Não existe para administradores (nunca vencem). */
  paidUntil?: number;
  phone?: string | null;
  /** Como pagar (texto configurado no servidor). */
  paymentInfo?: string;
  /** Pode buscar no catálogo inteiro (liberado pelo administrador). */
  catalog?: true;
  /** Está no programa de indicação (liberado pelo administrador). */
  referral?: true;
  /** Mensalidade dessa pessoa (centavos), quando definida. */
  priceCents?: number;
}

/** Em que pé está uma pessoa indicada (para quem indicou). */
export type ReferralStage =
  /** Esperando o administrador aprovar. */
  | "pending"
  /** Aprovada, ainda sem pagar a primeira mensalidade. */
  | "unpaid"
  /** Pagou: o valor fica guardado por 30 dias (estorno, cancelamento). */
  | "waiting"
  /** Passaram os 30 dias: falta o administrador pagar. */
  | "available"
  | "paid"
  | "canceled";

/** GET /referral: o link e as pessoas indicadas. */
export interface ReferralInfo {
  code: string;
  /** Quanto ganha por indicado que pagar (centavos). */
  rewardCents: number;
  people: { email: string; since: number; stage: ReferralStage; amountCents?: number; availableAt?: number }[];
  totals: { waitingCents: number; availableCents: number; paidCents: number };
}

export interface SessionResponse extends AccountBilling {
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
export interface AccountInfo extends AccountBilling {
  status: AccountStatus;
  admin?: true;
  /** Pedidos de acesso esperando (só para administradores). */
  pendingRequests?: number;
}

