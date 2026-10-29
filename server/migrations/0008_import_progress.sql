-- Quanto do download de cada música já andou (0 a 100), contado pelo celular que baixa.
-- Quem pediu vê a barra andar, mesmo sem ser o celular dele que está baixando.
ALTER TABLE import_tracks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
