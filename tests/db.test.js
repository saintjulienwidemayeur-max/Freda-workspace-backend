const test = require('node:test');
const assert = require('node:assert');
const { openDb, translate } = require('../src/db');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const dbs = [];
const open = async () => { const d = openDb({ file: ':memory:' }); dbs.push(d); await d.ready; return d; };
test.after(async () => { for (const d of dbs) await d.close(); });
const user = (d, id, email = id + '@x.test') => d.run('INSERT INTO users (id, email, created_at) VALUES (?,?,?)', id, email, 'now');

test('« ? » -> $n, sans toucher aux « ? » entre apostrophes', () => {
  assert.strictEqual(translate("SELECT * FROM t WHERE a = ? AND b = 'x?y' AND c = ? AND d LIKE '%?'"), "SELECT * FROM t WHERE a = $1 AND b = 'x?y' AND c = $2 AND d LIKE '%?'");
});

test('migrations appliquées une seule fois, dans l’ordre ; schémas isolés entre bases', async () => {
  const a = await open(), b = await open();
  await user(a, 'u1');
  assert.strictEqual((await a.get('SELECT COUNT(*) AS n FROM users')).n, 1);
  assert.strictEqual((await b.get('SELECT COUNT(*) AS n FROM users')).n, 0, 'autre base : vide');
  const v = (await a.all('SELECT version FROM app_migrations ORDER BY version')).map((r) => r.version);
  assert.deepStrictEqual(v, ['001_init', '002_security', '003_supabase_hardening', '004_mailbox_photos']);
});

test('types : entiers 64 bits et agrégats rendus en nombres JavaScript (jamais en chaînes)', async () => {
  const d = await open();
  await user(d, 'u1');
  await d.run('INSERT INTO orders (id, user_id, reference, kind, status, amount, created_at, updated_at, last_check) VALUES (?,?,?,?,?,?,?,?,?)', 'o1', 'u1', 'R1', 'domain', 'x', 12.99, 'n', 'n', Date.now());
  const r = await d.get('SELECT last_check, amount, (SELECT COUNT(*) FROM orders) AS n, (SELECT SUM(amount) FROM orders) AS total FROM orders');
  assert.strictEqual(typeof r.last_check, 'number'); assert.ok(r.last_check > 1.7e12, 'millisecondes : dépasse 32 bits');
  assert.deepStrictEqual([r.amount, r.n, r.total], [12.99, 1, 12.99]);
});

test('transactions : annulation complète en cas d’erreur, imbriquées rejointes, tout appel db.* dans la tx en fait partie', async () => {
  const d = await open();
  await assert.rejects(d.tx(async () => { await user(d, 'a'); await user(d, 'b'); throw new Error('boom'); }), /boom/);
  assert.strictEqual((await d.get('SELECT COUNT(*) AS n FROM users')).n, 0, 'rien n’a été enregistré');
  await d.tx(async () => { await user(d, 'c'); await d.tx(async () => { await d.run('UPDATE users SET name = ? WHERE id = ?', 'Cé', 'c'); }); });
  assert.strictEqual((await d.get('SELECT name FROM users WHERE id = ?', 'c')).name, 'Cé');
  await assert.rejects(d.tx(async () => { await user(d, 'd'); await d.tx(async () => { await user(d, 'e'); throw new Error('interne'); }); }), /interne/);
  assert.strictEqual((await d.get('SELECT COUNT(*) AS n FROM users')).n, 1, 'l’erreur d’une tx imbriquée annule aussi la tx extérieure');
});

test('transactions concurrentes : jamais mélangées (chacune est atomique vis-à-vis des autres)', async () => {
  const d = await open();
  const work = (id, fail) => d.tx(async () => { await user(d, id); await new Promise((r) => setTimeout(r, 5)); await user(d, id + '2'); if (fail) throw new Error('x'); });
  const res = await Promise.allSettled([work('a'), work('b', true), work('c'), user(d, 'hors-tx')]);
  assert.deepStrictEqual(res.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  const ids = (await d.all('SELECT id FROM users ORDER BY id')).map((r) => r.id);
  assert.deepStrictEqual(ids, ['a', 'a2', 'c', 'c2', 'hors-tx'], 'la tx annulée ne laisse rien, les autres sont complètes');
});

test('compteur atomique : 40 numéros demandés en parallèle, tous différents et consécutifs', async () => {
  const d = await open();
  const take = () => d.get('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value', 'invoice-2026');
  const vals = (await Promise.all(Array.from({ length: 40 }, take))).map((r) => r.value).sort((x, y) => x - y);
  assert.deepStrictEqual(vals, Array.from({ length: 40 }, (_, i) => i + 1));
});

test('contraintes : doublon -> code 23505 ; la route renvoie 409 « duplicate », jamais 500 ; clé étrangère -> 409', async () => {
  const d = await open();
  await user(d, 'u1', 'a@x.test');
  await assert.rejects(user(d, 'u2', 'a@x.test'), (e) => e.code === '23505');
  await assert.rejects(d.run('INSERT INTO orders (id, user_id, reference, kind, status, amount, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', 'o', 'inconnu', 'R', 'k', 's', 1, 'n', 'n'), (e) => e.code === '23503');
});

test('sécurité : RLS activée sur toutes les tables, aucune politique (accès uniquement par le backend)', async () => {
  const d = await open();
  const rows = await d.all("SELECT c.relname, c.relrowsecurity AS rls FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace AND c.relname <> 'app_migrations' ORDER BY 1");
  assert.ok(rows.length >= 15);
  assert.deepStrictEqual(rows.filter((r) => !r.rls).map((r) => r.relname), [], 'tables sans RLS');
  assert.strictEqual((await d.get("SELECT COUNT(*) AS n FROM pg_policies WHERE schemaname = current_schema()")).n, 0, 'aucune politique : l’API publique ne voit rien');
});

test('une inscription avec un e-mail déjà pris répond 409 (pas 500) même si la vérification préalable est contournée par une requête parallèle', async () => {
  const t = await setup({ env: { AUTH_MODE: 'jwt' } });
  const body = { name: 'Alice Test', email: 'dup@example.com', password: 'Motdepasse#2026' };
  const res = await Promise.all([1, 2, 3].map(() => t.api('/api/auth/signup', { method: 'POST', body })));
  const codes = res.map((r) => r.status).sort();
  assert.ok(codes.filter((c) => c === 200).length === 1 && codes.every((c) => c === 200 || c === 409), 'un seul compte créé, les autres en 409 : ' + codes);
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM users WHERE email = 'dup@example.com'")).n, 1);
});
