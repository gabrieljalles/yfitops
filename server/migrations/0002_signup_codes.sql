-- Código de 6 dígitos enviado por e-mail na criação de conta.
CREATE TABLE signup_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
