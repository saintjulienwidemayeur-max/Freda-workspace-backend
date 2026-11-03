/**
 * Base de données SQLite (module intégré node:sqlite, Node ≥ 22.5). Un seul fichier, migrations versionnées.
 * Convient à UNE instance (disque persistant Render). Pour plusieurs instances, remplacez par PostgreSQL :
 * tout l'accès passe par ces quatre helpers (get, all, run, tx), le reste du code ne contient pas de SQL spécifique à SQLite.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  /* 1 — schéma initial */
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT, company TEXT NOT NULL DEFAULT '', tax_id TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT 'Haïti', billing_email TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'Français', created_at TEXT NOT NULL
  );
  CREATE TABLE oauth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY (provider, subject));
  CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE payment_methods (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '', last4 TEXT NOT NULL DEFAULT '', exp TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), reference TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    status TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', payload TEXT NOT NULL DEFAULT '{}',
    payment_method TEXT NOT NULL DEFAULT '', charge_id TEXT NOT NULL DEFAULT '', redirect_url TEXT NOT NULL DEFAULT '',
    dry_run INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', last_check INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX orders_user ON orders(user_id);
  CREATE INDEX orders_status ON orders(status);
  CREATE TABLE idempotency (user_id TEXT NOT NULL, key TEXT NOT NULL, order_id TEXT NOT NULL, PRIMARY KEY (user_id, key));
  CREATE TABLE domains (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, status TEXT NOT NULL,
    external INTEGER NOT NULL DEFAULT 0, dns_mode TEXT NOT NULL DEFAULT 'registrar', registered_at TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '', auto_renew INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 1,
    is_primary INTEGER NOT NULL DEFAULT 0, dry_run INTEGER NOT NULL DEFAULT 0, registrar_cost REAL, order_id TEXT NOT NULL DEFAULT '',
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
  CREATE TABLE subscriptions (user_id TEXT PRIMARY KEY REFERENCES users(id), plan TEXT NOT NULL, cycle TEXT NOT NULL, status TEXT NOT NULL, renews_at TEXT NOT NULL, started_at TEXT NOT NULL, notices INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE mailboxes (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), domain TEXT NOT NULL, local_part TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'Utilisateur', used_gb REAL NOT NULL DEFAULT 0, provider_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, last_login TEXT
  );
  CREATE TABLE aliases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), from_addr TEXT NOT NULL UNIQUE, to_addr TEXT NOT NULL, provider_ref TEXT NOT NULL DEFAULT '');
  CREATE TABLE invoices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), date TEXT NOT NULL, label TEXT NOT NULL, amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, order_id TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, icon TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX activity_user ON activity(user_id);
  `,
  /* 2 — Stripe : client Stripe par compte, carte Stripe par moyen de paiement */
  `
  ALTER TABLE users ADD COLUMN stripe_customer_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE payment_methods ADD COLUMN stripe_pm TEXT NOT NULL DEFAULT '';
  `,
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    raw.exec('BEGIN');
    try { raw.exec(MIGRATIONS[v]); raw.exec(`PRAGMA user_version = ${v + 1}`); raw.exec('COMMIT'); }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  }
  let depth = 0;
  return {
    get: (sql, ...p) => raw.prepare(sql).get(...p) || null,
    all: (sql, ...p) => raw.prepare(sql).all(...p),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
    /** Transaction (réentrante : les appels imbriqués rejoignent la transaction extérieure). */
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE'); depth++;
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
      finally { depth--; }
    },
    close: () => raw.close(),
  };
}

module.exports = { openDb };
