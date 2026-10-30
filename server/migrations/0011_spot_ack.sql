-- O celular confirma que recebeu a tarefa (link ou música). Se a conexão caiu bem na
-- hora da entrega, ninguém confirma e a tarefa volta para a fila em segundos, em vez
-- de ficar presa até o prazo de 10 minutos. As que já estão em andamento contam como confirmadas.
ALTER TABLE import_requests ADD COLUMN acked INTEGER NOT NULL DEFAULT 1;
ALTER TABLE import_tracks ADD COLUMN acked INTEGER NOT NULL DEFAULT 1;
