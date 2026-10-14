CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  auth_salt TEXT NOT NULL,
  auth_hash TEXT NOT NULL,
  wrapped_master_key TEXT NOT NULL,
  escrow_master_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  wrapped_private_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Metadados criptografados (músicas, grupos, histórico).
CREATE TABLE items (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enc TEXT,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX items_seq ON items(owner, seq);

-- Arquivos criptografados no R2 (chave: owner/id).
CREATE TABLE blobs (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);

CREATE TABLE recovery_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

-- Grupos compartilhados: payload cifrado para o destinatário.
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX shares_to ON shares(to_user);
CREATE INDEX shares_from ON shares(from_user);

-- Quais blobs um compartilhamento libera (IDs são HMACs, não revelam conteúdo).
CREATE TABLE share_blobs (
  share_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  PRIMARY KEY (share_id, blob_id)
);
CREATE INDEX share_blobs_lookup ON share_blobs(owner, blob_id);
