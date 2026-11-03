/**
 * Base de données PostgreSQL (Supabase en production), accès ASYNCHRONE : get, all, run, tx.
 *  - DATABASE_URL défini  -> pilote « pg » (pool de connexions) vers Supabase (utiliser l'URI du « Session pooler »).
 *  - sinon (développement, tests) -> PGlite : vrai PostgreSQL exécuté dans Node (DB_FILE = dossier de données, « :memory: » = mémoire).
 * Les requêtes s'écrivent avec des « ? » (convertis en $1, $2…). Les migrations sont les fichiers migrations/*.sql, appliquées dans l'ordre au démarrage
 * (table app_migrations, verrou consultatif : deux instances qui démarrent ensemble ne se marchent pas dessus).
 * Transactions : db.tx(async () => { … }) ; tout appel db.* fait DANS la fonction (même à travers des await) rejoint automatiquement la transaction
 * (AsyncLocalStorage), les tx imbriquées rejoignent la tx extérieure. Entiers 64 bits et NUMERIC sont rendus en nombres JavaScript.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_KEY = 727001;

/** « ? » -> « $n », sans toucher aux « ? » dans les littéraux '…'. */
function translate(sql) {
  let out = '', n = 0, quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") quoted = !quoted;
    out += c === '?' && !quoted ? '$' + (++n) : c;
  }
  return out;
}
const norm = (params) => params.map((v) => (v === undefined ? null : v));

function migrationFiles(dir = DEFAULT_MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort().map((f) => ({ version: f.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/* ---------- Pilote pg (Supabase / PostgreSQL) ---------- */
function createPgDriver({ url, ca, poolMax, migrationsDir }) {
  const { Pool, types } = require('pg');
  const u = new URL(url);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  u.searchParams.delete('sslmode');                                  // le réglage SSL est explicite ci-dessous (sinon la chaîne de connexion l'écraserait)
  const pool = new Pool({
    connectionString: u.toString(), max: poolMax || 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 30000,
    ssl: local ? false : (ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }),
    types: { getTypeParser: (oid, fmt) => (oid === 20 || oid === 1700 ? Number : types.getTypeParser(oid, fmt)) },
  });
  pool.on('error', () => { /* connexion inactive perdue : le pool en rouvre une */ });
  return {
    async query(text, params, ctx) { const r = await ((ctx && ctx.client) || pool).query(text, params); return { rows: r.rows, count: r.rowCount }; },
    async tx(fn, als) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const out = await als.run({ client }, fn); await client.query('COMMIT'); return out; }
      catch (e) { try { await client.query('ROLLBACK'); } catch (x) { /* connexion déjà perdue */ } throw e; }
      finally { client.release(); }
    },
    async migrate() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        await client.query('CREATE TABLE IF NOT EXISTS app_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
        const done = new Set((await client.query('SELECT version FROM app_migrations')).rows.map((r) => r.version));
        for (const m of migrationFiles(migrationsDir)) {
          if (done.has(m.version)) continue;
          await client.query(m.sql);
          await client.query('INSERT INTO app_migrations (version, applied_at) VALUES ($1, $2)', [m.version, new Date().toISOString()]);
        }
        await client.query('COMMIT');
      } catch (e) { try { await client.query('ROLLBACK'); } catch (x) { /* ignoré */ } throw e; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

/* ---------- Pilote PGlite (développement et tests) : UNE session partagée -> verrou ; un schéma par base ---------- */
const liteInstances = new Map();
function liteShared(dir) {
  if (!liteInstances.has(dir)) {
    liteInstances.set(dir, (async () => {
      const { PGlite } = require('@electric-sql/pglite');
      if (dir !== ':memory:') fs.mkdirSync(path.resolve(dir), { recursive: true });
      const db = new PGlite(dir === ':memory:' ? undefined : path.resolve(dir), { parsers: { 20: Number, 1700: Number } });
      await db.waitReady;
      return { db, tail: Promise.resolve(), handles: 0 };
    })());
  }
  return liteInstances.get(dir);
}
function createLiteDriver({ dir, migrationsDir }) {
  const memory = dir === ':memory:';
  const schema = memory ? 's' + crypto.randomBytes(5).toString('hex') : 'public';
  let shared = null;
  const sh = async () => shared || (shared = await liteShared(dir));
  // la session est unique : chaque opération (ou transaction entière) passe dans une file ; les appels faits DANS une transaction la contournent
  const enqueue = async (fn) => { const s = await sh(); const run = s.tail.then(fn, fn); s.tail = run.catch(() => {}); return run; };
  const raw = async (text, params) => { const s = await sh(); await s.db.exec(`SET search_path TO "${schema}"`); const r = await s.db.query(text, params); return { rows: r.rows, count: r.affectedRows ?? r.rows.length }; };
  const rawExec = async (sql) => { const s = await sh(); await s.db.exec(`SET search_path TO "${schema}"`); await s.db.exec(sql); };
  return {
    query: (text, params, ctx) => (ctx ? raw(text, params) : enqueue(() => raw(text, params))),
    tx: (fn, als) => enqueue(async () => {
      await rawExec('BEGIN');
      try { const out = await als.run({ inTx: true }, fn); await rawExec('COMMIT'); return out; }
      catch (e) { try { await rawExec('ROLLBACK'); } catch (x) { /* ignoré */ } throw e; }
    }),
    migrate: () => enqueue(async () => {
      const s = await sh();
      if (memory) { await s.db.exec(`CREATE SCHEMA "${schema}"`); s.handles++; }
      await rawExec('CREATE TABLE IF NOT EXISTS app_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const done = new Set((await raw('SELECT version FROM app_migrations', [])).rows.map((r) => r.version));
      for (const m of migrationFiles(migrationsDir)) {
        if (done.has(m.version)) continue;
        await rawExec('BEGIN');
        try { await rawExec(m.sql); await raw('INSERT INTO app_migrations (version, applied_at) VALUES ($1, $2)', [m.version, new Date().toISOString()]); await rawExec('COMMIT'); }
        catch (e) { try { await rawExec('ROLLBACK'); } catch (x) { /* ignoré */ } throw e; }
      }
    }),
    close: () => enqueue(async () => {
      const s = await sh();
      if (memory) { await s.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); s.handles--; }
      if (!s.handles && !memory) { await s.db.close(); liteInstances.delete(dir); }
    }),
  };
}

/** Ouvre la base. Retourne tout de suite un objet utilisable : chaque appel attend la fin des migrations (db.ready). */
function openDb({ url, file, ca, poolMax, migrationsDir } = {}) {
  const drv = url ? createPgDriver({ url, ca, poolMax, migrationsDir }) : createLiteDriver({ dir: file || ':memory:', migrationsDir });
  const als = new AsyncLocalStorage();
  const ready = drv.migrate();
  ready.catch(() => {});                                            // l'erreur remonte au premier appel (ou à « await db.ready »), jamais en rejet non géré
  const q = async (sql, params) => { await ready; return drv.query(translate(sql), norm(params), als.getStore()); };
  return {
    ready,
    async get(sql, ...p) { return (await q(sql, p)).rows[0] || null; },
    async all(sql, ...p) { return (await q(sql, p)).rows; },
    async run(sql, ...p) { return { changes: (await q(sql, p)).count }; },
    /** Transaction. Réentrante : un appel imbriqué (même indirect) rejoint la transaction en cours. */
    async tx(fn) { await ready; return als.getStore() ? fn() : drv.tx(fn, als); },
    async close() { try { await ready; } catch (e) { /* migration échouée : rien à nettoyer */ } await drv.close(); },
  };
}

module.exports = { openDb, translate };
