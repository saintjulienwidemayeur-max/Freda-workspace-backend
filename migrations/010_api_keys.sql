-- Entégrations & API : clés API personnelles d'une boîte (lecture seule ou lecture + envoi), identifiant de boîte dédié à l'API, webhook « nouveau message » et
-- compteur quotidien d'envois. La clé en clair n'est JAMAIS conservée : seulement son empreinte HMAC-SHA256 (calculée avec une clé dérivée de DATA_KEY).
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, name TEXT NOT NULL,
  scope TEXT NOT NULL, key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, created_ms BIGINT NOT NULL, last_used_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX api_keys_mailbox ON api_keys(mailbox_id);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
-- mot de passe d'application Purelymail « Freda API » (un par boîte), chiffré : sert à lire / envoyer pour le compte des clés et à surveiller l'arrivée de messages (webhook)
CREATE TABLE api_credentials (
  mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE, secret_enc TEXT NOT NULL, created_at TEXT NOT NULL
);
ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;
-- un webhook par boîte ; secret de signature chiffré (affiché une seule fois à la création / rotation)
CREATE TABLE api_webhooks (
  mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE, url TEXT NOT NULL, secret_enc TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_ms BIGINT NOT NULL, last_uid BIGINT,
  failures INTEGER NOT NULL DEFAULT 0, last_status TEXT NOT NULL DEFAULT '', last_delivery_at TEXT NOT NULL DEFAULT '', disabled_reason TEXT NOT NULL DEFAULT ''
);
ALTER TABLE api_webhooks ENABLE ROW LEVEL SECURITY;
CREATE TABLE api_usage (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, day TEXT NOT NULL, sends INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (mailbox_id, day)
);
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;
