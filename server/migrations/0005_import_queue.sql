-- Fila de importação por link. Quem pede não baixa nada: um celular Android com
-- o app aberto (ou tocando música) e no Wi-Fi lê o link, baixa cada música e
-- envia ao catálogo. Só quem pediu recebe as músicas na biblioteca.

-- Um link pedido (vídeo, playlist, álbum ou mix).
CREATE TABLE import_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  -- Escolhas de quem pediu: {"tags": [...], "playlist": true}
  opts TEXT NOT NULL DEFAULT '{}',
  -- queued = esperando um celular ler o link; listing = um celular lendo;
  -- listed = as músicas estão na fila (import_tracks); failed = o link não deu.
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT,
  -- Origem da playlist ("youtube-playlist:<id>"...), para ligar à playlist do app.
  source TEXT,
  name TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  device TEXT,
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX import_requests_user ON import_requests(user_id, created_at);
CREATE INDEX import_requests_status ON import_requests(status, created_at);

-- Cada música de um pedido.
CREATE TABLE import_tracks (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  -- O que se sabe da faixa (título, artista, videoId ou a busca do Spotify/Deezer...).
  meta TEXT NOT NULL,
  -- queued | working | done | failed | skipped
  status TEXT NOT NULL DEFAULT 'queued',
  song_id TEXT,
  error TEXT,
  -- Quem pediu já recebeu na biblioteca.
  delivered INTEGER NOT NULL DEFAULT 0,
  device TEXT,
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX import_tracks_request ON import_tracks(request_id, pos);
CREATE INDEX import_tracks_status ON import_tracks(status);

-- Celulares ajudando agora (para revezar: quem acabou de baixar passa a vez).
CREATE TABLE import_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  last_done_at INTEGER NOT NULL DEFAULT 0,
  -- O YouTube barrou este celular: descansa até esta hora.
  blocked_until INTEGER NOT NULL DEFAULT 0
);
