const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const j = (r) => r.json();
const buy = (t, body) => t.user('/api/checkout', { method: 'POST', body });
const topup = (t, amount, method = 'moncash') => buy(t, { kind: 'topup', amount, method });
const bal = async (t) => j(await t.user('/api/balance'));
const run = (t) => t.app.app.jobs.run();
const r2 = (n) => Math.round(n * 100) / 100;

/** Client avec domaine, offre Business payée (démo) et première boîte contact@neuf.com ; courriel d'inscription : paul@example.com. */
async function withMail() {
  const t = await setup({ payments: demoPay });
  await buy(t, { kind: 'domain', domains: ['neuf.com'], years: 1 });
  await buy(t, { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact' } });
  t.price = t.cfg.plans.business.monthly;
  t.mailer.sent.length = 0;
  return t;
}

test('recharge : montant borné, solde crédité une seule fois, facture et reçu, historique', async () => {
  const t = await setup({ payments: demoPay });
  assert.strictEqual((await topup(t, 1)).status, 400, 'sous le minimum');
  assert.strictEqual((await topup(t, 100000)).status, 400, 'au-dessus du maximum');
  assert.strictEqual((await topup(t, 'abc')).status, 400);
  assert.strictEqual((await buy(t, { kind: 'topup', amount: 10, method: 'balance' })).status, 400, 'le solde ne se recharge pas avec le solde');
  assert.strictEqual((await bal(t)).balance, 0);
  const r = await j(await topup(t, 10));
  assert.strictEqual(r.status, 'succeeded');
  const b = await bal(t);
  assert.strictEqual(b.balance, 10);
  assert.strictEqual(b.balanceHtg, Math.floor(10 * t.cfg.pricing.htgRate));
  assert.deepStrictEqual(b.entries.map((e) => [e.kind, e.amount]), [['topup', 10]]);
  assert.strictEqual((await t.db.get('SELECT label FROM invoices')).label, 'Recharge du solde');
  assert.ok(t.mailer.sent.some((m) => /Recharge reçue/.test(m.subject) && m.text.includes('$10.00')));
  await t.app.app.orders.fulfill(r.orderId);                      // rejeu : aucun second crédit
  assert.strictEqual((await bal(t)).balance, 10);
  assert.strictEqual((await t.api('/api/balance')).status, 401);
});

test('payer avec le solde : refusé s’il ne suffit pas (détails), accepté sinon ; jamais deux achats avec le même argent', async () => {
  const t = await setup({ payments: demoPay });
  const no = await buy(t, { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'balance' });
  assert.strictEqual(no.status, 402);
  const nb = await j(no);
  assert.strictEqual(nb.code, 'insufficient_balance');
  assert.strictEqual(nb.details.missing, 12.99);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM domains')).n, 0);
  await topup(t, 20);
  const ok = await j(await buy(t, { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'balance' }));
  assert.strictEqual(ok.status, 'succeeded');
  assert.strictEqual((await bal(t)).balance, 7.01);
  assert.deepStrictEqual((await bal(t)).entries.map((e) => e.kind).sort(), ['charge', 'topup']);
  assert.ok(t.mailer.sent.some((m) => /payé avec votre solde/.test(m.subject) && m.text.includes('$7.01')));
  // course : 13.01 $ de solde, deux domaines à 12.99 $ en même temps -> un seul passe
  await topup(t, 6);
  const res = await Promise.all([buy(t, { kind: 'domain', domains: ['alpha.com'], years: 1, method: 'balance' }), buy(t, { kind: 'domain', domains: ['beta.com'], years: 1, method: 'balance' })]);
  assert.deepStrictEqual(res.map((r) => r.status).sort(), [200, 402]);
  assert.ok((await bal(t)).balance >= 0, 'jamais de solde négatif');
});

test('offre échue : payée automatiquement avec le solde, une seule fois par période ; paiement automatique coupé -> rien n’est prélevé', async () => {
  const t = await withMail();
  await topup(t, 50);
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(1));
  const before = (await bal(t)).balance;
  await run(t);
  const s = await t.db.get('SELECT renews_at, status FROM subscriptions');
  assert.ok(s.renews_at > days(25), 'période prolongée d’un mois');
  assert.strictEqual((await bal(t)).balance, r2(before - t.price));
  await run(t); await run(t);
  assert.strictEqual((await t.db.all("SELECT 1 FROM balance_entries WHERE kind = 'charge'")).length, 1, 'une seule fois par période');
  // paiement automatique coupé par le client : le solde ne bouge pas, un simple rappel part
  assert.strictEqual((await t.user('/api/balance', { method: 'PATCH', body: { autoPay: false } })).status, 200);
  await t.db.run('UPDATE subscriptions SET renews_at = ?, notices = 0', days(2));      // autre échéance : autre période, autre clé d’idempotence
  const mid = (await bal(t)).balance;
  t.mailer.sent.length = 0;
  await run(t);
  assert.strictEqual((await bal(t)).balance, mid);
  assert.ok(t.mailer.sent.length >= 1 && !t.mailer.sent.some((m) => /Solde insuffisant/.test(m.subject)), 'solde suffisant : simple rappel');
  // rallumé : l'échéance en attente est payée tout de suite
  assert.strictEqual((await t.user('/api/balance', { method: 'PATCH', body: { autoPay: true } })).status, 200);
  assert.ok((await t.db.get('SELECT renews_at FROM subscriptions')).renews_at > days(25));
  assert.strictEqual((await t.user('/api/balance', { method: 'PATCH', body: { autoPay: 'oui' } })).status, 400);
});

test('solde trop bas avant l’échéance : e-mail « solde insuffisant » à l’adresse d’inscription ET à la boîte Freda Mail créée, une fois par seuil', async () => {
  const t = await withMail();
  await t.db.run('UPDATE subscriptions SET renews_at = ?, notices = 0', days(3));
  await run(t);
  const low = t.mailer.sent.filter((m) => /Solde insuffisant/.test(m.subject));
  assert.deepStrictEqual(low.map((m) => m.to).sort(), ['contact@neuf.com', 'paul@example.com']);
  assert.ok(low[0].text.includes('Il manque $' + t.price.toFixed(2)));
  assert.match(low[0].text, /HTG/);
  assert.match(low[0].text, /facturation\?topup=\d+/);
  await run(t); await run(t);
  assert.strictEqual(t.mailer.sent.filter((m) => /Solde insuffisant/.test(m.subject)).length, 2, 'pas de doublon au même seuil');
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(1));        // seuil suivant
  await run(t);
  assert.strictEqual(t.mailer.sent.filter((m) => /Solde insuffisant/.test(m.subject)).length, 4);
  // solde partiel : le message dit exactement ce qu'il manque
  t.mailer.sent.length = 0;
  await topup(t, 5);
  await t.db.run('UPDATE subscriptions SET renews_at = ?, notices = 0', days(0));
  await run(t);
  const partial = t.mailer.sent.find((m) => /Solde insuffisant/.test(m.subject));
  assert.ok(partial);
  assert.ok(partial.text.includes('Il manque $' + (t.price - 5).toFixed(2)));
});

test('recharge d’un client en retard : l’offre échue (même suspendue) est payée aussitôt, les boîtes rouvrent', async () => {
  const t = await withMail();
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9));
  await run(t);
  assert.strictEqual((await t.db.get('SELECT status FROM subscriptions')).status, 'suspended');
  const r = await j(await topup(t, 50));
  assert.strictEqual(r.status, 'succeeded');
  const s = await t.db.get('SELECT status, renews_at FROM subscriptions');
  assert.strictEqual(s.status, 'active');
  assert.ok(s.renews_at > days(20));
  assert.strictEqual((await t.db.get("SELECT provider_status AS s FROM mailboxes WHERE local_part = 'contact'")).s, 'active');
  assert.strictEqual((await bal(t)).balance, r2(50 - t.price));
});

test('domaine proche de l’expiration : renouvelé avec le solde ; offre résiliée : jamais de prélèvement ; tableau admin : total des soldes', async () => {
  const t = await withMail();
  await topup(t, 100);
  await t.db.run('UPDATE domains SET expires_at = ?, dry_run = 0', days(5));
  await run(t);
  assert.ok((await t.db.get('SELECT expires_at FROM domains')).expires_at > days(300), 'domaine renouvelé un an');
  await run(t);
  assert.strictEqual((await t.db.all("SELECT 1 FROM orders WHERE kind = 'renewal'")).length, 1);
  await t.user('/api/subscription/cancel', { method: 'POST' });
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(1));
  const before = (await bal(t)).balance;
  await run(t);
  assert.strictEqual((await bal(t)).balance, before);
  const adm = await setup({ payments: demoPay, env: { ADMIN_TOKEN: 'a'.repeat(32) } });
  await topup(adm, 30);
  const o = await j(await adm.api('/api/admin/overview', { headers: { Authorization: 'Bearer ' + 'a'.repeat(32) } }));
  assert.deepStrictEqual(o.wallets, { total: 30, customers: 1 });
  assert.strictEqual(o.revenue.total, 30, 'une recharge payée compte comme argent encaissé');
});
