-- Freda Workspace : schéma PostgreSQL initial (Supabase). Montants en double precision, horodatages en millisecondes en BIGINT, drapeaux en INTEGER 0/1.
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT, company TEXT NOT NULL DEFAULT '', tax_id TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT 'Haïti', billing_email TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'Français', created_at TEXT NOT NULL, stripe_customer_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE oauth_identities (
  provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY (provider, subject)
);
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE payment_methods (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '', last4 TEXT NOT NULL DEFAULT '', exp TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, stripe_pm TEXT NOT NULL DEFAULT ''
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), reference TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  status TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', payload TEXT NOT NULL DEFAULT '{}',
  payment_method TEXT NOT NULL DEFAULT '', charge_id TEXT NOT NULL DEFAULT '', redirect_url TEXT NOT NULL DEFAULT '',
  dry_run INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', last_check BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX orders_user ON orders(user_id);
CREATE INDEX orders_status ON orders(status);
CREATE TABLE idempotency (
  user_id TEXT NOT NULL, key TEXT NOT NULL, order_id TEXT NOT NULL, PRIMARY KEY (user_id, key)
);
CREATE TABLE domains (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, status TEXT NOT NULL,
  external INTEGER NOT NULL DEFAULT 0, dns_mode TEXT NOT NULL DEFAULT 'registrar', registered_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '', auto_renew INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 1,
  is_primary INTEGER NOT NULL DEFAULT 0, dry_run INTEGER NOT NULL DEFAULT 0, registrar_cost DOUBLE PRECISION, order_id TEXT NOT NULL DEFAULT '',
  connected_at TEXT NOT NULL DEFAULT '', renewal_notices INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX domains_user ON domains(user_id);
CREATE UNIQUE INDEX domains_user_name ON domains(user_id, name);
-- un nom de domaine ne peut être « actif » que chez un seul client ; plusieurs demandes « pending » (non vérifiées) peuvent coexister
CREATE UNIQUE INDEX domains_active_name ON domains(name) WHERE status <> 'pending';
CREATE TABLE dns_records (
  id TEXT PRIMARY KEY, domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE, type TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  ttl INTEGER NOT NULL DEFAULT 3600, priority INTEGER, managed INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT '', provider_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX dns_domain ON dns_records(domain_id);
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id), plan TEXT NOT NULL, cycle TEXT NOT NULL, status TEXT NOT NULL, renews_at TEXT NOT NULL,
  started_at TEXT NOT NULL, notices INTEGER NOT NULL DEFAULT 0, cancel_at_period_end INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), domain TEXT NOT NULL, local_part TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'Utilisateur', used_gb DOUBLE PRECISION NOT NULL DEFAULT 0, provider_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, last_login TEXT, provider_user TEXT NOT NULL DEFAULT '', rule_state TEXT NOT NULL DEFAULT '',
  tokens_valid_after BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX mailboxes_user ON mailboxes(user_id);
CREATE TABLE aliases (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), from_addr TEXT NOT NULL UNIQUE, to_addr TEXT NOT NULL, provider_ref TEXT NOT NULL DEFAULT ''
);
CREATE TABLE invoices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), date TEXT NOT NULL, label TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, order_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX invoices_user ON invoices(user_id);
CREATE TABLE activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id TEXT NOT NULL, icon TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX activity_user ON activity(user_id);
CREATE TABLE push_devices (
  id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), platform TEXT NOT NULL, token TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (mailbox_id, platform, token)
);
CREATE INDEX push_devices_mailbox ON push_devices(mailbox_id);
CREATE TABLE push_credentials (
  mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id), secret_enc TEXT NOT NULL, created_at TEXT NOT NULL, last_uid BIGINT
);
-- compteurs atomiques (numéros de facture) : une insertion « ON CONFLICT DO UPDATE … RETURNING » ne donne jamais deux fois le même numéro, même avec plusieurs requêtes en parallèle
CREATE TABLE counters (
  name TEXT PRIMARY KEY, value BIGINT NOT NULL
);
