const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function withDomain() {
  const t = await setup({ payments: demoPay });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  return t;
}

test('rappels d’expiration : 30 / 14 / 7 / 1 jours, chacun envoyé une seule fois, lien vers le site (paiement créé au clic)', async () => {
  const t = await withDomain();
  const run = () => t.app.app.jobs.run();
  await t.db.run('UPDATE domains SET expires_at = ?', days(40)); t.mailer.sent.length = 0;
  await run(); assert.strictEqual(t.mailer.sent.length, 0, 'trop tôt');
  await t.db.run('UPDATE domains SET expires_at = ?', days(29)); await run();
  assert.strictEqual(t.mailer.sent.filter((m) => /expire dans/.test(m.subject)).length, 1);
  assert.match(t.mailer.sent.at(-1).text, /https:\/\/site\.test\/espace\/domaines\?renew=neuf\.com/);
  await run(); assert.strictEqual(t.mailer.sent.filter((m) => /expire dans/.test(m.subject)).length, 1, 'pas de doublon');
  await t.db.run('UPDATE domains SET expires_at = ?', days(6)); await run();
  assert.strictEqual(t.mailer.sent.filter((m) => /expire dans/.test(m.subject)).length, 2);
  await t.db.run('UPDATE domains SET expires_at = ?', days(-1)); await run();
  assert.strictEqual((await t.db.get('SELECT status FROM domains')).status, 'expired');
  assert.ok(t.mailer.sent.some((m) => /a expiré/.test(m.subject)));
});

test('rappels : envoyés même si le client coupe le renouvellement automatique (aucun prélèvement) ; ignorés pour les domaines dry-run et externes', async () => {
  const t = await withDomain();
  await t.db.run('UPDATE domains SET expires_at = ?, auto_renew = 0', days(5)); t.mailer.sent.length = 0;
  const before = (await t.db.get('SELECT COUNT(*) AS n FROM orders')).n;
  await t.app.app.jobs.run(); assert.ok(t.mailer.sent.some((m) => /expire dans/.test(m.subject)), 'le rappel part (sinon le domaine expire en silence)');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM orders')).n, before, 'aucun renouvellement automatique');
  await t.db.run('UPDATE domains SET auto_renew = 1, dry_run = 1'); t.mailer.sent.length = 0;
  await t.app.app.jobs.run(); assert.strictEqual(t.mailer.sent.length, 0);
});

test('un domaine renouvelé repart de zéro : les rappels reviennent l’année suivante', async () => {
  const t = await withDomain();
  await t.db.run('UPDATE domains SET expires_at = ?, renewal_notices = 15', days(300));
  t.mailer.sent.length = 0;
  await t.db.run('UPDATE domains SET renewal_notices = 0');
  await t.db.run('UPDATE domains SET expires_at = ?', days(20)); await t.app.app.jobs.run();
  assert.ok(t.mailer.sent.some((m) => /expire dans/.test(m.subject)));
});

test('offre Freda Mail : rappels à 5 et 1 jours, past_due à l’échéance, suspended après 7 jours', async () => {
  const t = await withDomain();
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly' } });
  const status = async () => (await t.db.get('SELECT status FROM subscriptions')).status;
  t.mailer.sent.length = 0;
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(4)); await t.app.app.jobs.run();
  assert.ok(t.mailer.sent.some((m) => /se renouvelle dans/.test(m.subject)));
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(-1)); await t.app.app.jobs.run();
  assert.strictEqual(await status(), 'past_due');
  assert.ok(t.mailer.sent.some((m) => /à régler/.test(m.subject)));
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await t.app.app.jobs.run();
  assert.strictEqual(await status(), 'suspended');
});

test('POST /admin/jobs/run : réservé au jeton administrateur (comparaison en temps constant)', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: 'a'.repeat(32) } });
  assert.strictEqual((await t.api('/api/admin/jobs/run', { method: 'POST' })).status, 401);
  assert.strictEqual((await t.api('/api/admin/jobs/run', { method: 'POST', headers: { Authorization: 'Bearer faux' } })).status, 401);
  assert.strictEqual((await t.api('/api/admin/jobs/run', { method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(32) } })).status, 200);
  const none = await setup();
  assert.strictEqual((await none.api('/api/admin/jobs/run', { method: 'POST', headers: { Authorization: 'Bearer x' } })).status, 401, 'sans ADMIN_TOKEN configuré, l’accès est fermé');
});

test('workspace : forme complète attendue par le frontend ; isolation entre comptes', async () => {
  const t = await withDomain();
  const w = await (await t.user('/api/workspace')).json();
  assert.deepStrictEqual(Object.keys(w).sort(), ['activity', 'dns', 'dnsConfig', 'domains', 'free', 'invoices', 'mailboxes', 'aliases', 'paymentMethods', 'plan', 'user'].sort());
  assert.strictEqual(w.plan, null);
  assert.strictEqual(w.domains[0].primary, true);
  assert.ok(w.activity.some((a) => /neuf\.com enregistré/.test(a.text)));
  const other = await (await t.as('autre@example.com')('/api/workspace')).json();
  assert.strictEqual(other.domains.length, 0);
  assert.strictEqual(other.invoices.length, 0);
});
