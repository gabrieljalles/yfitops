-- Quem pediu cada música, guardado de vez. Antes isso vinha só da fila de pedidos:
-- quando a pessoa tirava o pedido pronto da lista (ou depois de 30 dias), a música
-- passava a contar para o celular que baixou.
CREATE TABLE song_requests (
  user_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, song_id)
);
CREATE INDEX song_requests_song ON song_requests(song_id, created_at);

-- O que ainda está na fila diz quem pediu.
INSERT OR IGNORE INTO song_requests (user_id, song_id, created_at)
  SELECT r.user_id, t.song_id, r.created_at
  FROM import_tracks t JOIN import_requests r ON r.id = t.request_id
  WHERE t.song_id IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id);

-- O resto: quem tem a música na biblioteca (quem pediu sempre fica com ela).
INSERT OR IGNORE INTO song_requests (user_id, song_id, created_at)
  SELECT o.user_id, o.song_id, s.created_at
  FROM song_owners o JOIN songs s ON s.id = o.song_id
  WHERE NOT EXISTS (SELECT 1 FROM song_requests q WHERE q.song_id = o.song_id);

-- Sem ninguém: quem enviou o arquivo.
INSERT OR IGNORE INTO song_requests (user_id, song_id, created_at)
  SELECT s.uploaded_by, s.id, s.created_at
  FROM songs s
  WHERE s.uploaded_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM song_requests q WHERE q.song_id = s.id)
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = s.uploaded_by);
