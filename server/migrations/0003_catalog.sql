-- Catálogo compartilhado: cada música existe uma vez só (MP3, sem criptografia).
-- As bibliotecas (ainda criptografadas) apontam para ela pelo id.
CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  -- "artista|título|versão" normalizados (ver packages/core/src/catalog.ts).
  match_key TEXT NOT NULL,
  -- Texto da busca: artista, título e álbum sem acentos.
  search TEXT NOT NULL,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL,
  size INTEGER NOT NULL,
  cover_size INTEGER NOT NULL DEFAULT 0,
  -- SHA-256 do arquivo original enviado (acha o mesmo arquivo exato).
  source_hash TEXT,
  -- pending = enviando; ready = no catálogo; merged = duplicada, juntada em merged_into.
  status TEXT NOT NULL DEFAULT 'pending',
  merged_into TEXT,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX songs_match ON songs(match_key, status);
CREATE INDEX songs_hash ON songs(source_hash);
CREATE INDEX songs_status ON songs(status, created_at);

-- Origens exatas de cada música: "youtube:<id>", "spotify:<id>", "deezer:<id>".
-- Se outra pessoa já importou o mesmo vídeo/faixa, nem baixa de novo.
CREATE TABLE song_sources (
  source TEXT PRIMARY KEY,
  song_id TEXT NOT NULL
);
CREATE INDEX song_sources_song ON song_sources(song_id);
