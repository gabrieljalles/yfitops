-- Quanto cada pessoa paga, os pagamentos registrados e as indicações.

-- Mensalidade combinada com a pessoa (centavos). Vazio = a mensalidade padrão (settings.price_cents).
ALTER TABLE users ADD COLUMN price_cents INTEGER;
-- Programa de indicação: só quem o administrador liberou tem link (o código continua o mesmo se ele desligar e ligar de novo).
ALTER TABLE users ADD COLUMN referral_on INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN referral_code TEXT;
-- Quem indicou essa pessoa (id). Um nível só: indicar não passa adiante.
ALTER TABLE users ADD COLUMN referred_by TEXT;
CREATE UNIQUE INDEX users_referral_code ON users(referral_code);
CREATE INDEX users_referred_by ON users(referred_by);

-- Valores gerais do painel: price_cents (mensalidade padrão) e reward_cents (valor por indicado).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Cada "liberar meses" do painel. O e-mail fica guardado para o histórico continuar certo se a conta for apagada.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  months INTEGER NOT NULL,
  prev_paid_until INTEGER NOT NULL,
  paid_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  refunded_at INTEGER
);
CREATE INDEX payments_user ON payments(user_id, created_at);
CREATE INDEX payments_created ON payments(created_at);

-- O valor que a indicadora ganha por um indicado: um por indicado, na primeira mensalidade paga,
-- liberado 30 dias depois (sem estorno nem cancelamento nesse tempo).
CREATE TABLE referral_rewards (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL UNIQUE,
  referred_email TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  canceled_at INTEGER,
  cancel_reason TEXT,
  paid_at INTEGER
);
CREATE INDEX referral_rewards_referrer ON referral_rewards(referrer_id);
