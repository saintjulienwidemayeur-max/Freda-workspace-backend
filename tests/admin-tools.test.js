const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const TOKEN = 'a'.repeat(32);
const adm = (t, path, opts = {}) => t.api(path, { ...opts, headers: { Authorization: 'Bearer ' + (opts.token === undefined ? TOKEN : opts.token) } });
const mk = async (t, email) => { await t.as(email)('/api/balance'); return t.db.get('SELECT id FROM users WHERE email = ?', email); };   // crée le client (mode démo)
const grant = (t, body) => adm(t, '/api/admin/grants', { method: 'POST', body });
const monthsAhead = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('délai dépassé'); await new Promise((r) => setTimeout(r, 40)); } };

test('outils admin : jeton obligatoire sur toutes les routes', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  for (const [m, p] of [['GET', '/api/admin/customers?q=ab'], ['GET', '/api/admin/grants'], ['POST', '/api/admin/grants'], ['GET', '/api/admin/announcements'], ['GET', '/api/admin/announcements/audience?audience=all'], ['POST', '/api/admin/announcements/test'], ['POST', '/api/admin/announcements'], ['POST', '/api/admin/announcements/ann_x/resume']]) {
    assert.strictEqual((await t.api(p, { method: m, headers: { Authorization: 'Bearer faux' }, body: m === 'POST' ? {} : undefined })).status, 401, p);
  }
});

test('offrir une offre : abonnement actif pour N mois, sans paiement ni renouvellement automatique, journal, e-mail au client', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  const u = await mk(t, 'ami@example.com');
  const r = await (await grant(t, { email: 'AMI@example.com', plan: 'business', months: 3, note: 'Partenaire', notify: true })).json();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.endsOn, monthsAhead(3));
  assert.strictEqual(r.notified, true);
  const s = await t.db.get('SELECT * FROM subscriptions WHERE user_id = ?', u.id);
  assert.deepStrictEqual([s.plan, s.status, s.renews_at, s.cancel_at_period_end], ['business', 'active', monthsAhead(3), 1], 'résiliée en fin de période : s’arrête seule, jamais de prélèvement');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM orders')).n, 0, 'aucune commande, aucun paiement');
  assert.strictEqual((await t.db.get('SELECT note FROM admin_grants WHERE user_id = ?', u.id)).note, 'Partenaire');
  const mail = t.mailer.sent.find((m) => m.to === 'ami@example.com');
  assert.match(mail.subject, /offerte/);
  assert.match(mail.text, /Business/);
  const list = await (await adm(t, '/api/admin/grants')).json();
  assert.strictEqual(list.grants[0].email, 'ami@example.com');
  assert.deepStrictEqual(list.plans.map((p) => p.id), ['starter', 'business', 'enterprise']);
});

test('offrir une offre : validations (offre gratuite / inconnue, durée, client inconnu) et recherche de client', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  await mk(t, 'zoe@example.com');
  assert.strictEqual((await grant(t, { email: 'zoe@example.com', plan: 'free', months: 2 })).status, 400, 'l’offre gratuite n’est pas une offre à offrir');
  assert.strictEqual((await grant(t, { email: 'zoe@example.com', plan: 'nope', months: 2 })).status, 400);
  for (const months of [0, -1, 1.5, 37, 'abc', null]) assert.strictEqual((await grant(t, { email: 'zoe@example.com', plan: 'starter', months })).status, 400, String(months));
  assert.strictEqual((await grant(t, { email: 'inconnu@example.com', plan: 'starter', months: 2 })).status, 404);
  assert.strictEqual((await grant(t, { email: 'pas-un-email', plan: 'starter', months: 2 })).status, 400);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM subscriptions')).n, 0, 'aucun effet sur un refus');
  assert.deepStrictEqual((await (await adm(t, '/api/admin/customers?q=zo')).json()).customers.map((c) => c.email), ['zoe@example.com']);
  assert.deepStrictEqual((await (await adm(t, '/api/admin/customers?q=z')).json()).customers, [], 'recherche : 2 caractères au minimum');
});

test('offrir la même offre prolonge depuis l’échéance ; un client qui paie déjà garde son renouvellement ; une autre offre remplace l’actuelle (signalé)', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  const u = await mk(t, 'pay@example.com');
  const renews = monthsAhead(2);
  await t.db.run("INSERT INTO subscriptions (user_id, plan, cycle, status, renews_at, started_at, cancel_at_period_end) VALUES (?,?,?,?,?,?,0)", u.id, 'starter', 'monthly', 'active', renews, '2026-01-01');
  const ext = await (await grant(t, { email: 'pay@example.com', plan: 'starter', months: 2 })).json();
  assert.strictEqual(ext.extended, true);
  assert.strictEqual(ext.keepsRenewal, true);
  const s = await t.db.get('SELECT renews_at, cancel_at_period_end FROM subscriptions WHERE user_id = ?', u.id);
  assert.ok(s.renews_at > renews && s.renews_at <= monthsAhead(4).replace(/-\d\d$/, '-31'), 'prolongée à partir de l’échéance, pas d’aujourd’hui');
  assert.strictEqual(s.cancel_at_period_end, 0, 'son renouvellement payant n’est pas coupé');
  const rep = await (await grant(t, { email: 'pay@example.com', plan: 'enterprise', months: 1 })).json();
  assert.strictEqual(rep.replaced.plan, 'starter');
  assert.strictEqual((await t.db.get('SELECT plan, cancel_at_period_end FROM subscriptions WHERE user_id = ?', u.id)).cancel_at_period_end, 1);
});

test('annonce : test, confirmation du nombre exact, envoi à tous une seule fois, échecs réessayables sans doublon', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) await mk(t, e);
  const aud = await (await adm(t, '/api/admin/announcements/audience?audience=all')).json();
  assert.strictEqual(aud.count, 3);
  assert.strictEqual((await adm(t, '/api/admin/announcements/audience?audience=xx')).status, 400);
  const body = { subject: 'Nouveauté Freda Mail', message: 'Bonne nouvelle : la version web est disponible.\nhttps://freda-mail-web.onrender.com' };
  assert.strictEqual((await adm(t, '/api/admin/announcements/test', { method: 'POST', body: { ...body, to: 'moi@example.com' } })).status, 200);
  assert.strictEqual(t.mailer.sent.filter((m) => m.to === 'moi@example.com').length, 1);
  assert.strictEqual((await adm(t, '/api/admin/announcements', { method: 'POST', body: { ...body, audience: 'all', expectedCount: 2 } })).status, 409, 'nombre différent : rien n’est envoyé');
  assert.strictEqual((await adm(t, '/api/admin/announcements', { method: 'POST', body: { subject: 'x', message: 'court', audience: 'all', expectedCount: 3 } })).status, 400);
  assert.strictEqual(t.mailer.sent.length, 1, 'seul le test est parti');
  // un envoi échoue pour b@
  const realSend = t.mailer.send;
  t.mailer.send = async (m) => { if (m.to === 'b@example.com') throw new Error('Brevo down'); return realSend(m); };
  const r = await (await adm(t, '/api/admin/announcements', { method: 'POST', body: { ...body, audience: 'all', expectedCount: 3 } })).json();
  assert.strictEqual(r.total, 3);
  const done = await until(async () => { const a = (await (await adm(t, '/api/admin/announcements')).json()).announcements[0]; return a.status === 'done' && a; });
  assert.deepStrictEqual([done.sent, done.failed], [2, 1]);
  assert.match(t.mailer.sent.find((m) => m.to === 'a@example.com').text, /^Bonjour/);
  assert.match(t.mailer.sent.find((m) => m.to === 'a@example.com').text, /compte Freda Workspace/);
  // reprise simple : rien de plus n’est envoyé ; avec « réessayer les échecs » : seul b@ reçoit
  t.mailer.send = realSend;
  const before = t.mailer.sent.length;
  await adm(t, `/api/admin/announcements/${r.id}/resume`, { method: 'POST', body: {} });
  await until(async () => (await (await adm(t, '/api/admin/announcements')).json()).announcements[0].status === 'done');
  assert.strictEqual(t.mailer.sent.length, before, 'jamais de doublon');
  await adm(t, `/api/admin/announcements/${r.id}/resume`, { method: 'POST', body: { retryFailed: true } });
  const fin = await until(async () => { const a = (await (await adm(t, '/api/admin/announcements')).json()).announcements[0]; return a.status === 'done' && a.failed === 0 && a; });
  assert.deepStrictEqual([fin.sent, fin.failed], [3, 0]);
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) assert.strictEqual(t.mailer.sent.filter((m) => m.to === e).length, 1, e + ' : exactement une fois');
});

test('annonce : groupes (abonnés / sans offre)', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  const a = await mk(t, 'abo@example.com'); await mk(t, 'libre@example.com');
  await t.db.run("INSERT INTO subscriptions (user_id, plan, cycle, status, renews_at, started_at) VALUES (?,?,?,?,?,?)", a.id, 'starter', 'monthly', 'active', monthsAhead(1), '2026-01-01');
  const n = async (k) => (await (await adm(t, '/api/admin/announcements/audience?audience=' + k)).json()).count;
  assert.deepStrictEqual([await n('all'), await n('subscribers'), await n('no_subscription')], [2, 1, 1]);
});
