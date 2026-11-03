const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
const { sellPrice } = require('../src/pricing');
const { loadConfig, assertSafe } = require('../src/config');
test.after(closeAll);

const buy = (t, body, headers) => t.user('/api/checkout', { method: 'POST', headers, body: { kind: 'domain', years: 1, ...body } });

test('tarification : marge en %, marge minimale, arrondi à x.99', () => {
  const p = { markupPercent: 30, minMarkup: 1.5 };
  assert.strictEqual(sellPrice(10, p), 12.99);
  assert.strictEqual(sellPrice(2, p), 3.99);
});

test('recherche : prix de vente serveur, indisponible détecté, extension absente du registraire non proposée', async () => {
  const t = await setup();
  const r = await t.api('/api/domains/search?q=pris');
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.exact.available, false);
  const net = d.results.find((x) => x.tld === '.net');
  assert.strictEqual(net.available, true);
  assert.strictEqual(net.price, 14.99);
  assert.ok(!d.results.some((x) => x.tld === '.xyz'));
});

test('recherche : entrée invalide -> 400 ; clé API invalide -> 502 sans fuite de la clé', async () => {
  const t = await setup();
  assert.strictEqual((await t.api('/api/domains/search?q=%20')).status, 400);
  const bad = await setup({ env: { NAMESILO_API_KEY: 'mauvaise-cle' } });
  const r = await bad.api('/api/domains/search?q=test');
  assert.strictEqual(r.status, 502);
  assert.ok(!JSON.stringify(await r.json()).includes('mauvaise-cle'));
});

test('achat (paiement immédiat) : prix serveur, enregistrement, verrouillage, domaine, facture, e-mails, zone', async () => {
  const t = await setup({ payments: { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} } });
  const r = await buy(t, { domains: ['neuf.com'], years: 2, amount: 0.01 });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.status, 'succeeded');
  assert.strictEqual(d.amount, 12.99 + 15.99);
  const reg = t.ns.calls.find((c) => c.op === 'registerDomain').q;
  assert.deepStrictEqual([reg.domain, reg.years, reg.private, reg.auto_renew], ['neuf.com', '2', '1', '0']);
  assert.ok(t.ns.calls.some((c) => c.op === 'domainLock'));
  const w = await (await t.user('/api/workspace')).json();
  assert.strictEqual(w.domains[0].name, 'neuf.com');
  assert.strictEqual(w.domains[0].autoRenew, true);
  assert.match(w.invoices[0].id, /^FW-\d{4}-0001$/);
  assert.strictEqual(w.invoices[0].amount, 28.98);
  assert.ok(t.mailer.sent.some((m) => /Reçu/.test(m.subject)));
  assert.ok(t.mailer.sent.some((m) => /Domaine enregistré/.test(m.subject)));
});

test('achat : indisponible / premium / durée minimale > 1 an -> 409 sans paiement ni enregistrement', async () => {
  const t = await setup();
  t.state.premium.push('cher.com'); t.state.longTerm.push('long.com');
  for (const domain of ['pris.com', 'cher.com', 'long.com']) assert.strictEqual((await buy(t, { domains: [domain] })).status, 409, domain);
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'));
  assert.strictEqual(t.paym.calls.length, 0);
});

test('achat : entrées invalides rejetées', async () => {
  const t = await setup();
  for (const b of [{ domains: ['pas un domaine'] }, { domains: ['a.xyz'] }, { domains: ['a-.com'] }, { domains: ['ok.com'], years: 99 }, { domains: ['ok.com'], years: 1.5 }, { domains: [] }, { domains: ['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com', 'a6.com'] }])
    assert.strictEqual((await buy(t, b)).status, 400, JSON.stringify(b));
  assert.strictEqual((await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['x.com'] } })).status, 401, 'authentification obligatoire');
});

test('achat : solde NameSilo insuffisant -> 503 avant tout paiement', async () => {
  const t = await setup();
  t.state.balance = 1;
  assert.strictEqual((await buy(t, { domains: ['neuf.com'] })).status, 503);
  assert.strictEqual(t.paym.calls.length, 0);
});

test('achat : échec d’enregistrement après paiement immédiat -> remboursement intégral', async () => {
  const t = await setup({ payments: { name: 'test', async create() { return { status: 'paid' }; }, async verify() { return { status: 'paid' }; }, async refund() { return { id: 'r' }; } } });
  t.state.failRegister.push('neuf.com');
  const r = await buy(t, { domains: ['neuf.com'] });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(t.refunds.length, 1);
  assert.strictEqual(t.refunds[0].amount, 12.99);
});

test('achat de deux domaines dont un échoue : remboursement partiel et facture du seul domaine acheté', async () => {
  const t = await setup({ payments: { name: 'test', async create() { return { status: 'paid' }; }, async verify() { return { status: 'paid' }; }, async refund() { return { id: 'r' }; } } });
  t.state.failRegister.push('deux.net');
  const d = await (await buy(t, { domains: ['un.com', 'deux.net'] })).json();
  assert.deepStrictEqual(d.domains, ['un.com']);
  assert.strictEqual(d.orderStatus, 'partially_refunded');
  assert.strictEqual(t.refunds[0].amount, 14.99);
  const w = await (await t.user('/api/workspace')).json();
  assert.strictEqual(w.invoices[0].amount, 12.99);
});

test('achat : codes 301/302 = succès, 252 toléré, coût réel NameSilo enregistré', async () => {
  for (const code of [301, 302]) {
    const t = await setup({ payments: { name: 'test', async create() { return { status: 'paid' }; }, async verify() { return { status: 'paid' }; }, async refund() {} } });
    t.state.registerCode = code; t.state.lockCode = 252;
    assert.strictEqual((await buy(t, { domains: ['neuf.com'] })).status, 200, 'code ' + code);
    assert.strictEqual((await t.db.get('SELECT registrar_cost FROM domains')).registrar_cost, 10);
  }
});

test('enregistrement : ns1-ns13 transmis seulement s’il y en a au moins 2', async () => {
  const pay = { name: 'test', async create() { return { status: 'paid' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
  const one = await setup({ env: { NAMESERVERS: 'ns1.fredaworkspace.com' }, payments: pay });
  await buy(one, { domains: ['neuf.com'] });
  assert.strictEqual(one.ns.calls.find((c) => c.op === 'registerDomain').q.ns1, undefined);
  const two = await setup({ env: { NAMESERVERS: 'ns1.fredaworkspace.com,ns2.fredaworkspace.com' }, payments: pay });
  await buy(two, { domains: ['neuf.com'] });
  const q = two.ns.calls.find((c) => c.op === 'registerDomain').q;
  assert.deepStrictEqual([q.ns1, q.ns2], ['ns1.fredaworkspace.com', 'ns2.fredaworkspace.com']);
});

test('idempotence : la même clé ne rachète pas ; un domaine déjà acheté -> 409', async () => {
  const t = await setup({ payments: { name: 'test', async create() { return { status: 'paid' }; }, async verify() { return { status: 'paid' }; }, async refund() {} } });
  const a = await (await buy(t, { domains: ['neuf.com'] }, { 'Idempotency-Key': 'k1' })).json();
  const b = await (await buy(t, { domains: ['neuf.com'] }, { 'Idempotency-Key': 'k1' })).json();
  assert.strictEqual(a.orderId, b.orderId);
  assert.strictEqual(t.ns.calls.filter((c) => c.op === 'registerDomain').length, 1);
  assert.strictEqual((await buy(t, { domains: ['neuf.com'] })).status, 409);
});

test('dry-run (défaut) : lectures réelles, mais aucun enregistrement ni verrouillage NameSilo', async () => {
  const t = await setup({ env: { NAMESILO_MODE: 'dry-run' } });
  assert.strictEqual(t.cfg.namesilo.dryRun, true);
  const d = await (await buy(t, { domains: ['neuf.com'] })).json();
  assert.strictEqual(d.dryRun, true);
  assert.ok(t.ns.calls.some((c) => c.op === 'checkRegisterAvailability'));
  assert.ok(!t.ns.calls.some((c) => ['registerDomain', 'domainLock'].includes(c.op)));
  assert.strictEqual((await t.db.get('SELECT dry_run FROM domains')).dry_run, 1);
});

test('configuration : dry-run par défaut ; démarrage refusé si dangereux', () => {
  assert.strictEqual(loadConfig({}).namesilo.mode, 'dry-run');
  assert.strictEqual(loadConfig({ NAMESILO_MODE: 'LIVE' }).namesilo.mode, 'dry-run');
  const base = { NAMESILO_API_KEY: 'k', JWT_SECRET: 'x'.repeat(40) };
  assert.ok(assertSafe(loadConfig({ ...base, NAMESILO_MODE: 'live', PAYMENTS_PROVIDER: 'demo' })).some((e) => /sans vrai paiement/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'demo' })).some((e) => /AUTH_MODE/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, PAYMENTS_PROVIDER: 'paym' })).some((e) => /PAYM_CLIENT_ID/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, NODE_ENV: 'production', MAILER: 'console' })).some((e) => /MAILER/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, NAMESERVERS: 'ns1.x.com' })).some((e) => /NAMESERVERS/.test(e)));
  assert.deepStrictEqual(assertSafe(loadConfig(base)), []);
});
