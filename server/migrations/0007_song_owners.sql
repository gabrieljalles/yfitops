-- Quem tem cada música do catálogo na biblioteca. As bibliotecas são criptografadas,
-- então o servidor não sabe o que tem nelas: o app informa só os ids das músicas
-- do catálogo (ao conferir duplicadas, em /songs/resolve).
CREATE TABLE song_owners (
  user_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  PRIMARY KEY (user_id, song_id)
);
CREATE INDEX song_owners_song ON song_owners(song_id);

-- Quando a conta informou suas músicas pela última vez. Enquanto alguma conta
-- aprovada nunca informou, a faxina não apaga nada (não dá para saber o que ela tem).
ALTER TABLE users ADD COLUMN library_reported_at INTEGER;

-- Desde quando a música está sem dono. Só é apagada depois de alguns dias assim.
ALTER TABLE songs ADD COLUMN orphan_since INTEGER;
