-- Aprovação de contas: quem pede para entrar espera o administrador aceitar.
-- Contas que já existiam continuam liberadas.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE users ADD COLUMN approved_at INTEGER;
CREATE INDEX users_status ON users(status);
-- Músicas apagadas pelo administrador ficam como 'removed' (sem arquivo), para
-- as bibliotecas de todos saberem que ela saiu do sistema.
