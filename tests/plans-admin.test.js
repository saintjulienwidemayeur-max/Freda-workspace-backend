const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
const { cycleMonths, cycleOf, cycleLabel } = require('../src/plans');
test.after(closeAll);

const TOKEN = 'a'.repeat(32);
const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const adm = (t, path, opts = {}) => t.api(path, { ...opts, headers: { Authorization: 'Bearer ' + (opts.token || TOKEN) } });
const putPlans = (t, body, token) => adm(t, '/api/admin/plans', { method: 'PUT', body, token });
const sub = (t, cycle, plan = 'starter') => t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan, cycle } });
const monthsAhead = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };

test('durées : 1 à 12 mois, 12 mois = 2 mois offerts, tout le reste refusé', () => {
  assert.deepStrictEqual(['monthly', 'yearly', 'm2', 'm3', 'm11'].map(cycleMonths), [1, 12, 2, 3, 11]);
  for (const bad of ['m1', 'm12', 'm13', 'm0', 'm-2', 'M3', 'weekly', '', undefined, null, 3]) assert.strictEqual(cycleMonths(bad), 0, String(bad));
  assert.deepStrictEqual([1, 6, 12].map(cycleOf), ['monthly', 'm6', 'yearly']);
  assert.deepStrictEqual(['monthly', 'yearly', 'm4'].map(cycleLabel), ['mensuel', 'annuel', '4 mois']);
});

test('l’offre Starter donne 2 boîtes ; le client choisit le nombre de mois : prix = mois × prix mensuel, 12 mois = 10 mois facturés, date de renouvellement exacte, facture lisible', async () => {
  const t = await setup({ payments: demoPay });
  const price = t.cfg.plans.starter.monthly;
  assert.strictEqual(t.cfg.plans.starter.mailboxes, 2);
  const pub = await (await t.api('/api/plans')).json();
  assert.strictEqual(pub.plans.starter.mailboxes, 2);
  assert.strictEqual(pub.plans.enterprise.mailboxes, null, 'illimité');
  for (const bad of ['m1', 'm13', 'abc', '']) assert.strictEqual((await sub(t, bad)).status, 400, bad);
  const r3 = await (await sub(t, 'm3')).json();
  assert.strictEqual(r3.amount, Math.round(price * 3 * 100) / 100);
  const row = await t.db.get('SELECT cycle, renews_at FROM subscriptions');
  assert.strictEqual(row.cycle, 'm3');
  assert.strictEqual(row.renews_at, monthsAhead(3));
  assert.strictEqual((await t.db.get('SELECT label FROM invoices')).label, 'Starter — 3 mois');
  const ry = await (await sub(t, 'yearly', 'business')).json();
  assert.strictEqual(ry.amount, Math.round(t.cfg.plans.business.monthly * 10 * 100) / 100, '12 mois = 10 mois facturés');
  assert.strictEqual((await t.db.get('SELECT renews_at FROM subscriptions')).renews_at, monthsAhead(12));
  const r7 = await (await sub(t, 'm7', 'business')).json();
  assert.strictEqual(r7.amount, Math.round(t.cfg.plans.business.monthly * 7 * 100) / 100);
});

test('administration : prix mensuels des offres modifiables, effet immédiat, bornes, remise à zéro, réservé à l’administrateur', async () => {
  const t = await setup({ payments: demoPay, env: { ADMIN_TOKEN: TOKEN } });
  assert.strictEqual((await t.api('/api/admin/plans')).status, 401);
  assert.strictEqual((await putPlans(t, { prices: { starter: 1 } }, 'b'.repeat(32))).status, 401);
  assert.strictEqual((await t.user('/api/admin/plans', { method: 'PUT', body: { prices: { starter: 1 } } })).status, 401, 'un client ne change jamais les prix');
  const cur = await (await adm(t, '/api/admin/plans')).json();
  assert.strictEqual(cur.custom, false);
  assert.deepStrictEqual(cur.plans.map((p) => [p.id, p.monthly]), [['starter', 2.99], ['business', 9.99], ['enterprise', 30]]);
  assert.strictEqual(cur.plans[0].mailboxes, 2);
  for (const bad of [{ prices: { starter: 0.1 } }, { prices: { starter: 5000 } }, { prices: { business: 'abc' } }, { prices: null }, {}, { prices: { starter: -3 } }]) {
    const r = await putPlans(t, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.strictEqual((await r.json()).code, 'invalid_plans');
  }
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM app_settings')).n, 0, 'rien d’enregistré après un refus');
  const saved = await (await putPlans(t, { prices: { starter: '3,50', business: 12 } })).json();
  assert.deepStrictEqual(saved.plans.map((p) => p.monthly), [3.5, 12, 30], 'les prix non fournis restent inchangés');
  assert.strictEqual(saved.custom, true);
  assert.strictEqual((await (await t.api('/api/plans')).json()).plans.starter.monthly, 3.5, 'le site voit le nouveau prix');
  const order = await (await sub(t, 'm2')).json();
  assert.strictEqual(order.amount, 7, 'nouvelle commande au nouveau prix : 2 × 3,50 $');
  const back = await (await putPlans(t, { reset: true })).json();
  assert.deepStrictEqual([back.custom, back.plans[0].monthly, back.plans[1].monthly], [false, 2.99, 9.99]);
  assert.strictEqual((await (await t.api('/api/plans')).json()).plans.starter.monthly, 2.99);
});
