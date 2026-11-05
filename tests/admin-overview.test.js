const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const TOKEN = 'a'.repeat(32);
const adm = (t, path, token = TOKEN) => t.api(path, { headers: { Authorization: 'Bearer ' + token } });

test('GET /api/admin/overview : réservé à l’administrateur (401 sans jeton ou avec un mauvais jeton)', async () => {
  const t = await setup({ payments: demoPay, env: { ADMIN_TOKEN: TOKEN } });
  assert.strictEqual((await t.api('/api/admin/overview')).status, 401);
  assert.strictEqual((await adm(t, '/api/admin/overview', 'b'.repeat(32))).status, 401);
  assert.strictEqual((await t.user('/api/workspace')).status, 200);
  assert.strictEqual((await t.api('/api/admin/overview', { headers: { 'X-Demo-User': 'paul@example.com' } })).status, 401, 'un client ne voit jamais le tableau de bord admin');
});

test('overview : clients, ventes par type et par jour, commandes, abonnements, domaines, boîtes et alertes de mise en production', async () => {
  const t = await setup({ payments: demoPay, env: { ADMIN_TOKEN: TOKEN } });
  const empty = await (await adm(t, '/api/admin/overview?days=7')).json();
  assert.strictEqual(empty.days, 7);
  assert.strictEqual(empty.revenue.series.length, 7);
  assert.strictEqual(empty.revenue.period, 0);
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: 'MonMotDePasse!2026' } } });
  const o = await (await adm(t, '/api/admin/overview')).json();
  assert.strictEqual(o.days, 30);
  assert.ok(o.customers.total >= 1 && o.customers.new >= 1);
  assert.ok(o.revenue.series.length === 30 && o.revenue.series.every((d) => /^\d{4}-\d\d-\d\d$/.test(d.day)));
  assert.strictEqual(typeof o.revenue.total, 'number');
  assert.ok(o.subscriptions.active >= 1, 'abonnement actif compté');
  assert.ok(o.domains.byStatus.active >= 1);
  assert.ok(o.mailboxes.active + o.mailboxes.notActive >= 1);
  assert.ok(Array.isArray(o.signups) && o.signups[0].email);
  assert.strictEqual(typeof o.system.uptimeSeconds, 'number');
  assert.ok(o.alerts.some((a) => a.code === 'not_production'), 'avertit que ce n’est pas la production');
  assert.ok(!JSON.stringify(o).match(/password|secret|token/i) || !JSON.stringify(o).includes(TOKEN), 'aucun secret dans la réponse');
  assert.strictEqual((await (await adm(t, '/api/admin/overview?days=9999')).json()).days, 90, 'plage bornée à 90 jours');
});
