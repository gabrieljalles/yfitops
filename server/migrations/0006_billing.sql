-- Cobrança: celular para contato e até quando o acesso está pago (ms desde 1970).
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN paid_until INTEGER NOT NULL DEFAULT 0;
-- Contas já liberadas ganham 30 dias para dar tempo de combinar o pagamento.
-- (Pedidos ainda esperando recebem os dias de teste quando o administrador aprovar.)
UPDATE users SET paid_until = (CAST(strftime('%s', 'now') AS INTEGER) + 30 * 86400) * 1000 WHERE status = 'approved';

-- Quem pode buscar no catálogo inteiro (liberado pelo administrador, só para pessoas de confiança).
-- As outras contas só veem as músicas que elas mesmas trouxeram.
ALTER TABLE users ADD COLUMN catalog_access INTEGER NOT NULL DEFAULT 0;

-- Compartilhamento entre pessoas foi removido.
DROP TABLE IF EXISTS share_blobs;
DROP TABLE IF EXISTS shares;
