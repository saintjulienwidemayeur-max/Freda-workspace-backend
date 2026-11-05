/**
 * Le VRAI pilote « pg » (celui de Supabase en production) contre un serveur PostgreSQL parlant le protocole réseau : PGlite exposé par un socket TCP.
 * Couvre : chaîne de connexion, pool, migrations (verrou consultatif, blocs DO), types, transactions, compteur atomique. Les codes d'erreur de contrainte (23505 / 23503) sont
 * vérifiés avec PGlite direct (tests/db.test.js) : ce serveur de test coupe la connexion après toute erreur SQL, ce que PostgreSQL ne fait pas.
 */
const test = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { openDb } = require('../src/db');

let lite, server, port;
test.before(async () => {
  lite = new PGlite(); await lite.waitReady;
  server = new PGLiteSocketServer({ db: lite, port: 0, host: '127.0.0.1' }); await server.start();
  port = server.server.address().port;
});
test.after(async () => { await server.stop(); await lite.close(); });

const settle = () => new Promise((r) => setTimeout(r, 400));       // le serveur de test libère la connexion de façon asynchrone après pool.end()
const opts = () => ({ url: url(), poolMax: 1 });      // le serveur de test (un seul client à la fois) n'accepte qu'UNE connexion
const url = () => `postgresql://postgres:secret@127.0.0.1:${port}/postgres?sslmode=require`;     // sslmode est retiré : hôte local -> pas de TLS
async function withDb(fn) {
  const d = openDb(opts());
  try { await d.ready; return await fn(d); } finally { await d.close().catch(() => {}); await settle(); }
}
const user = (d, id, email = id + '@x.test') => d.run('INSERT INTO users (id, email, created_at) VALUES (?,?,?)', id, email, 'now');

test('pg : migrations appliquées, relance sans effet (table app_migrations), types numériques', async () => {
  await withDb(async (d) => {
    assert.deepStrictEqual((await d.all('SELECT version FROM app_migrations ORDER BY version')).map((r) => r.version), ['001_init', '002_security', '003_supabase_hardening', '004_mailbox_photos', '005_balance', '006_settings', '007_user_token_revocation', '008_email_verification']);
    await user(d, 'u1');
    await d.run('INSERT INTO orders (id, user_id, reference, kind, status, amount, created_at, updated_at, last_check) VALUES (?,?,?,?,?,?,?,?,?)', 'o1', 'u1', 'R1', 'domain', 'x', 12.99, 'n', 'n', Date.now());
    const r = await d.get('SELECT last_check, amount, (SELECT COUNT(*) FROM orders) AS n, (SELECT SUM(amount) FROM orders) AS total FROM orders');
    assert.strictEqual(typeof r.last_check, 'number'); assert.ok(r.last_check > 1.7e12);
    assert.deepStrictEqual([r.amount, r.n, r.total], [12.99, 1, 12.99]);
  });
  await withDb(async (again) => { assert.strictEqual((await again.get('SELECT COUNT(*) AS n FROM app_migrations')).n, 8, 'seconde instance : rien à refaire, pas de doublon'); });
});

test('pg : transactions — annulation, imbriquées, et appels db.* faits dans la tx joints à SA connexion', async () => {
  await withDb(async (d) => {
    const n = async (ids) => (await d.get(`SELECT COUNT(*) AS n FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)).n;
    await assert.rejects(d.tx(async () => { await user(d, 'a'); await user(d, 'b'); throw new Error('boom'); }), /boom/);
    assert.strictEqual(await n(['a', 'b']), 0, 'rien n’a été enregistré');
    await d.tx(async () => { await user(d, 'c'); await d.tx(async () => { await d.run('UPDATE users SET name = ? WHERE id = ?', 'Cé', 'c'); }); });
    assert.strictEqual((await d.get('SELECT name FROM users WHERE id = ?', 'c')).name, 'Cé');
    await assert.rejects(d.tx(async () => { await user(d, 'd'); await d.tx(async () => { await user(d, 'e'); throw new Error('interne'); }); }), /interne/);
    assert.strictEqual(await n(['d', 'e']), 0, 'l’erreur d’une tx imbriquée annule aussi la tx extérieure');
  });
});

test('pg : compteur atomique (numéros de facture) sous requêtes parallèles', async () => {
  await withDb(async (d) => {
    const take = () => d.get('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value', 'c-pg');
    const vals = (await Promise.all(Array.from({ length: 12 }, take))).map((r) => r.value).sort((x, y) => x - y);
    assert.deepStrictEqual(vals, Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

test('pg : une migration en échec est annulée en entier et l’erreur remonte à db.ready', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freda-mig-'));
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations'))) fs.copyFileSync(path.join(__dirname, '..', 'migrations', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, '999_test_broken.sql'), 'CREATE TABLE ok_before (x int);\nCREATE TABLE users (x int);');       // 2e instruction : la table existe déjà
  try {
    const d = openDb({ ...opts(), migrationsDir: dir });
    await assert.rejects(d.ready, /already exists/);
    await assert.rejects(d.get('SELECT 1'), /already exists/, 'les appels suivants échouent aussi : jamais d’application à moitié migrée');
    await d.close().catch(() => {}); await settle();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  await withDb(async (probe) => { assert.strictEqual((await probe.get("SELECT to_regclass('ok_before') AS t")).t, null, 'la première instruction a été annulée avec la seconde'); });
});
