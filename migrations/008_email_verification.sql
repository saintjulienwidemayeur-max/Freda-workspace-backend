-- Vérification de l'adresse e-mail à l'inscription : lien à usage unique (valable 24 h). Les comptes existants sont considérés comme vérifiés.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified = 1;
CREATE TABLE email_verifications (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at BIGINT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
