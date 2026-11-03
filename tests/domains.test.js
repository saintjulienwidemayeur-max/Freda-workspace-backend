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

test('achat : indisponible / premium -> 409 sans paiement ni enregistrement ; duration=10 (réponse réelle de NameSilo) reste vendable', async () => {
  const t = await setup();
  t.state.premium.push('cher.com'); t.state.longTerm.push('long.com');
  for (const domain of ['pris.com', 'cher.com']) assert.strictEqual((await buy(t, { domains: [domain] })).status, 409, domain);
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'));
  assert.strictEqual(t.paym.calls.length, 0);
  const s = await (await t.api('/api/domains/search?q=long')).json();
  assert.strictEqual(s.exact.available, true, 'duration=10 ne rend pas le domaine indisponible');
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

test('configuration de production : paiements « demo » refusés, DATA_KEY et DATABASE_URL obligatoires ; staging toléré', () => {
  const base = { NAMESILO_API_KEY: 'k', NAMESILO_MODE: 'live', JWT_SECRET: 'j'.repeat(40), AUTH_MODE: 'jwt', MAILER: 'brevo', BREVO_API_KEY: 'b', DATABASE_URL: 'postgresql://u:p@h:5432/db', DATA_KEY: 'a'.repeat(64) };
  const errs = (env) => assertSafe(loadConfig({ ...base, ...env }));
  assert.ok(errs({ NODE_ENV: 'production', PAYMENTS_PROVIDER: 'paym', PAYM_CLIENT_ID: 'a', PAYM_CLIENT_SECRET: 'b', NAMESILO_MODE: 'dry-run' }).some((e) => /NAMESILO_MODE=live requis/.test(e)), 'dry-run interdit en production');
  assert.ok(errs({ NODE_ENV: 'production', PAYMENTS_PROVIDER: 'demo' }).some((e) => /demo.*interdit en production/.test(e)));
  assert.deepStrictEqual(errs({ NODE_ENV: 'production', PAYMENTS_PROVIDER: 'paym', PAYM_CLIENT_ID: 'a', PAYM_CLIENT_SECRET: 'b' }), []);
  assert.deepStrictEqual(errs({ NODE_ENV: 'staging', PAYMENTS_PROVIDER: 'demo', MAILER: 'console', DATABASE_URL: '', NAMESILO_MODE: 'dry-run' }), [], 'instance d’essai : paiements fictifs, e-mails en console, base locale');
  assert.ok(errs({ NODE_ENV: 'production', PAYMENTS_PROVIDER: 'paym', PAYM_CLIENT_ID: 'a', PAYM_CLIENT_SECRET: 'b', DATA_KEY: '' }).some((e) => /DATA_KEY/.test(e)));
  assert.ok(errs({ NODE_ENV: 'production', PAYMENTS_PROVIDER: 'paym', PAYM_CLIENT_ID: 'a', PAYM_CLIENT_SECRET: 'b', DATABASE_URL: '' }).some((e) => /DATABASE_URL/.test(e)));
  assert.ok(errs({ DATABASE_URL: 'mysql://x' }).some((e) => /invalide/.test(e)));
});

test('GET /api/health : 200 avec la base ; 503 si la base est inaccessible (Render retire alors l’instance)', async () => {
  const t = await setup({});
  const ok = await t.api('/api/health'); assert.strictEqual(ok.status, 200); assert.strictEqual((await ok.json()).database, true);
  await t.app.app.db.close();
  const down = await t.api('/api/health'); assert.strictEqual(down.status, 503); assert.strictEqual((await down.json()).code, 'db_unavailable');
});

test('rezime de démarrage : uniquement des booléens et des réglages non secrets, jamais une valeur de clé', () => {
  const { integrationSummary } = require('../src/config');
  const secrets = { JWT_SECRET: 'jwt-' + 'x'.repeat(40), DATA_KEY: 'a'.repeat(64), ADMIN_TOKEN: 'adm-secret', NAMESILO_API_KEY: 'ns-secret', STRIPE_SECRET_KEY: 'sk_live_secret', STRIPE_WEBHOOK_SECRET: 'whsec_secret', STRIPE_PUBLISHABLE_KEY: 'pk_live_pub', BREVO_API_KEY: 'brevo-secret', PURELYMAIL_API_KEY: 'pm-secret', ALERT_WEBHOOK_URL: 'https://hooks.example/secret', DATABASE_URL: 'postgresql://u:dbpassword@h:5432/db', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', PAYM_CLIENT_ID: 'pid', PAYM_CLIENT_SECRET: 'psecret' };
  const sum = integrationSummary(loadConfig(secrets));
  const text = JSON.stringify(sum);
  for (const v of Object.values(secrets)) assert.ok(!text.includes(v), 'fuite : ' + v);
  assert.deepStrictEqual([sum.jwtSecret, sum.dataKey, sum.adminToken, sum.namesilo, sum.stripeSecretKey, sum.stripeWebhookSecret, sum.stripePublishableKey, sum.brevo, sum.purelymail, sum.alertWebhook, sum.google, sum.paym], Array(12).fill(true));
  assert.strictEqual(sum.stripeUiMode, 'embedded');
  const empty = integrationSummary(loadConfig({}));
  assert.deepStrictEqual([empty.jwtSecret, empty.namesilo, empty.stripeSecretKey, empty.purelymail, empty.alertWebhook, empty.paym], Array(6).fill(false));
});

test('recherche : les 36 extensions sont vérifiées par lots de 10 (NameSilo trop lent sur un gros lot)', async () => {
  const tlds = '.com,.net,.org,.io,' + Array.from({ length: 30 }, (_, i) => '.x' + i).join(',');
  const t = await setup({ env: { DOMAIN_TLDS: tlds } });
  const r = await t.api('/api/domains/search?q=widemayeur');
  assert.strictEqual(r.status, 200);
  const checks = t.ns.calls.filter((c) => c.op === 'checkRegisterAvailability');
  assert.ok(checks.length >= 1 && checks.every((c) => c.q.domains.split(',').length <= 10));
});

test('NameSilo répond 503 une fois : la vérification de disponibilité est réessayée (pas de panne visible)', async () => {
  const { createClient } = require('../src/namesilo');
  let n = 0;
  const fetchImpl = async () => (++n === 1
    ? { ok: false, status: 503, json: async () => { throw new Error('html'); } }
    : { ok: true, status: 200, json: async () => ({ reply: { code: 300, available: [{ domain: 'a.com', price: 9, duration: 1 }] } }) });
  const c = createClient({ baseUrl: 'http://x', key: 'k' }, fetchImpl);
  const r = await c.checkAvailability(['a.com']);
  assert.strictEqual(n, 2);
  assert.strictEqual(r.available[0].domain, 'a.com');
});

test('GET /api/domains/prices : mêmes prix de vente que la recherche, triés du moins cher au plus cher', async () => {
  const t = await setup();
  const p = await (await t.api('/api/domains/prices')).json();
  assert.ok(p.tlds.length > 0);
  assert.deepStrictEqual(p.tlds.map((x) => x.price), p.tlds.map((x) => x.price).slice().sort((a, b) => a - b));
  const s = await (await t.api('/api/domains/search?q=exemple')).json();
  const com = p.tlds.find((x) => x.tld === '.com');
  assert.strictEqual(com.price, s.exact.price);
  assert.strictEqual(com.renew, s.exact.renew);
});

test('GET /api/admin/domain-prices : coût NameSilo, prix de vente et marge — réservé à l’administrateur', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: 'a'.repeat(32) } });
  assert.strictEqual((await t.api('/api/admin/domain-prices')).status, 401);
  const r = await t.api('/api/admin/domain-prices', { headers: { Authorization: 'Bearer ' + 'a'.repeat(32) } });
  assert.strictEqual(r.status, 200);
  const com = (await r.json()).tlds.find((x) => x.tld === '.com');
  assert.strictEqual(com.cost, 10);
  const sold = await (await t.api('/api/domains/search?q=exemple')).json();
  assert.strictEqual(com.price, sold.exact.price, 'le prix de vente affiché est celui de la recherche');
  assert.strictEqual(com.margin, Math.round((com.price - 10) * 100) / 100);
});

test('achat : confidentialité Whois — activée par défaut, désactivable par le client, valeur invalide refusée', async () => {
  const t = await setup();
  assert.strictEqual((await buy(t, { domains: ['optout.com'], whoisPrivacy: 'non' })).status, 400);
  assert.strictEqual((await buy(t, { domains: ['optout.com'], whoisPrivacy: false })).status, 200);
  assert.strictEqual((await buy(t, { domains: ['optin.com'], whoisPrivacy: true })).status, 200);
  assert.strictEqual((await buy(t, { domains: ['defaut.com'] })).status, 200);
  const priv = (d) => t.ns.calls.find((c) => c.op === 'registerDomain' && c.q.domain === d).q.private;
  assert.deepStrictEqual([priv('optout.com'), priv('optin.com'), priv('defaut.com')], ['0', '1', '1']);
});

test('prix barré : désactivé par défaut ; avec PRICE_COMPARE_PERCENT il est affiché mais le montant facturé ne change jamais', async () => {
  const off = await setup();
  const s0 = await (await off.api('/api/domains/search?q=barre')).json();
  assert.strictEqual(s0.exact.compare, undefined);
  const t = await setup({ env: { PRICE_COMPARE_PERCENT: '40' } });
  const s = await (await t.api('/api/domains/search?q=barre')).json();
  assert.ok(s.exact.compare > s.exact.price, 'prix barré supérieur au prix de vente');
  assert.ok(String(s.exact.compare).endsWith('.99'));
  const p = await (await t.api('/api/domains/prices')).json();
  assert.strictEqual(p.tlds.find((x) => x.tld === '.com').compare, s.exact.compare);
  const d = await (await buy(t, { domains: ['barre.com'] })).json();
  assert.strictEqual(d.amount, s.exact.price, 'on facture le prix de vente, jamais le prix barré');
});

test('recherche en deux temps : « main » = nom + .com/.net/.org en un seul appel NameSilo, « more » = le reste ; .com toujours en tête', async () => {
  const tlds = '.xyz,.shop,.club,.com,.net,.org,.io,.dev,.app,.cloud,.digital,.agency';
  const t = await setup({ env: { DOMAIN_TLDS: tlds } });
  const before = t.ns.calls.length;
  const m = await (await t.api('/api/domains/search?q=rapide&part=main')).json();
  const mainCalls = t.ns.calls.slice(before).filter((c) => c.op === 'checkRegisterAvailability');
  assert.strictEqual(mainCalls.length, 1, 'un seul appel de disponibilité');
  assert.deepStrictEqual(mainCalls[0].q.domains.split(','), ['rapide.com', 'rapide.net', 'rapide.org']);
  assert.strictEqual(m.exact.domain, 'rapide.com'); assert.strictEqual(m.partial, true);
  assert.deepStrictEqual(m.results.map((r) => r.tld), ['.net', '.org']);
  const more = await (await t.api('/api/domains/search?q=rapide&part=more')).json();
  assert.strictEqual(more.exact, undefined);
  assert.ok(!more.results.some((r) => ['.com', '.net', '.org'].includes(r.tld)));
  const all = await (await t.api('/api/domains/search?q=rapide')).json();
  assert.deepStrictEqual(all.results.slice(0, 2).map((r) => r.tld), ['.net', '.org'], '.com, .net, .org avant les autres');
  assert.strictEqual(all.results.length + 1, m.results.length + more.results.length + 1);
  assert.strictEqual((await t.api('/api/domains/search?q=rapide&part=zzz')).status, 400);
  const dev = await (await t.api('/api/domains/search?q=rapide.io&part=main')).json();
  assert.strictEqual(dev.exact.domain, 'rapide.io', 'l’extension demandée passe en premier');
});
