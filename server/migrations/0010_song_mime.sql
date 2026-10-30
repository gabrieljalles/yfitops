-- Formato do áudio de cada música do catálogo. As do YouTube entram em M4A (AAC),
-- como vêm, sem converter: menores que o MP3 192 kbps e tocam em todo lugar.
ALTER TABLE songs ADD COLUMN mime TEXT NOT NULL DEFAULT 'audio/mpeg';
