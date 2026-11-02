const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { loadConfig, assertSafe } = require('../src/config');
const { createApp } = require('../server');
const { signJwt } = require('../src/auth');
const { sellPrice } = require('../src/pricing');
const { createPayments, PaymentError } = require('../src/payments');

const closers = [];
test.after(() => closers.forEach((c) => { try { c(); } catch (e) { /* déjà fermé */ } }));

/* Faux serveur NameSilo : même enveloppe { request, reply: { code, detail, ... } } que celle supposée par le client. */
function fakeNameSilo(state) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const op = u.pathname.split('/').pop();
    const q = Object.fromEntries(u.searchParams);
    calls.push({ op, q });
    const reply = (r) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ request: { operation: op }, reply: r })); };
    if (q.key !== 'test-key') { res.statusCode = 401; return reply({ code: 110, detail: 'Invalid API key' }); }   // comportement réel : HTTP 401 + code 110
    if (op === 'getPrices') return reply({ code: 300, detail: 'success', com: { registration: '10.00', transfer: '10.00', renew: '12.00' }, net: { registration: '11.00', transfer: '11.00', renew: '13.00' }, org: { registration: '9.00', transfer: '9.00', renew: '11.00' }, io: { registration: '30.00', transfer: '30.00', renew: '40.00' } });
    if (op === 'checkRegisterAvailability') {
      // Formes de la référence officielle : available[] = { domain, price, premium (0/1), duration } ; unavailable = { domain } (objet si un seul)
      const ds = q.domains.split(',');
      const free = ds.filter((d) => !state.taken.includes(d));
      const taken = ds.filter((d) => state.taken.includes(d)).map((d) => ({ domain: d }));
      const item = (d) => ({ domain: d, price: 9.99, premium: state.premium.includes(d) ? 1 : 0, duration: state.longTerm.includes(d) ? 2 : 1 });
      const out = { code: 300, detail: 'success', available: free.map(item) };
      if (taken.length) out.unavailable = taken.length === 1 ? taken[0] : taken;
      return reply(out);
    }
    if (op === 'getAccountBalance') return reply({ code: 300, detail: 'success', balance: String(state.balance) });
    if (op === 'registerDomain') return state.failRegister.includes(q.domain) ? reply({ code: 261, detail: 'Registry error' }) : reply({ code: state.registerCode, detail: 'success', message: 'Your domain registration was successfully processed.', domain: q.domain, order_amount: 10 });
    if (op === 'domainLock') return state.lockCode === 252 ? reply({ code: 252, detail: 'Domain is already Locked - No update made.' }) : reply({ code: 300, detail: 'success' });
    reply({ code: 210, detail: 'unknown operation' });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: 'http://127.0.0.1:' + server.address().port + '/api' })));
}

async function setup(over = {}) {
  const state = { taken: ['pris.com'], premium: [], longTerm: [], balance: 500, failRegister: [], registerCode: 300, lockCode: 300 };
  const ns = await fakeNameSilo(state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
  const cfg = loadConfig({ NAMESILO_API_KEY: 'test-key', NAMESILO_BASE_URL: ns.url, AUTH_MODE: 'demo', DATA_FILE: path.join(dir, 's.json'), PRICE_MARKUP_PERCENT: '30', PRICE_MIN_MARKUP: '1.5', DOMAIN_TLDS: '.com,.net,.org,.io,.xyz', ...over.env });
  const refunds = [];
  const payments = over.payments || { name: 'test', async charge({ amount, reference }) { return { id: 'ch_' + reference, amount }; }, async refund(r) { refunds.push(r); return { id: 'rf' }; } };
  const app = createApp({ cfg, payments });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Demo-User': 'paul@example.com', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const close = () => { app.closeAllConnections(); app.close(); ns.server.closeAllConnections(); ns.server.close(); };
  closers.push(close);
  return { api, state, ns, refunds, cfg, close, base };
}

test('tarification : marge en %, marge minimale, arrondi à x.99', () => {
  const p = { markupPercent: 30, minMarkup: 1.5 };
  assert.strictEqual(sellPrice(10, p), 12.99);   // 13.00 -> 12.99+... (ceil(13)-0.01)
  assert.strictEqual(sellPrice(2, p), 3.99);     // la marge minimale s'applique (3.50 -> 3.99)
});

test('recherche : prix de vente serveur, indisponible détecté, extensions inconnues ignorées', async () => {
  const t = await setup();
  const r = await t.api('/api/domains/search?q=pris');
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.exact.domain, 'pris.com');
  assert.strictEqual(d.exact.available, false);
  assert.strictEqual(d.results.find((x) => x.tld === '.net').available, true);
  assert.strictEqual(d.results.find((x) => x.tld === '.net').price, 14.99);     // 11 * 1.3 = 14.3 -> 14.99
  assert.ok(!d.results.some((x) => x.tld === '.xyz'), '.xyz absent du registraire : non proposé');
  await t.close();
});

test('recherche : entrée invalide -> 400 ; clé jamais exposée', async () => {
  const t = await setup();
  const r = await t.api('/api/domains/search?q=%20');
  assert.strictEqual(r.status, 400);
  assert.ok(!JSON.stringify(await r.json()).includes('test-key'));
  await t.close();
});

test('achat : authentification obligatoire', async () => {
  const t = await setup();
  const r = await t.api('/api/checkout', { method: 'POST', headers: { 'X-Demo-User': '' }, body: { kind: 'domain', domain: 'neuf.com' } });
  assert.strictEqual(r.status, 401);
  await t.close();
});

test('achat : succès, prix recalculé côté serveur (montant du navigateur ignoré), domaine enregistré et verrouillé', async () => {
  const t = await setup();
  const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 2, amount: 0.01, saved: true, methodId: 'pm1' } });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.status, 'succeeded');
  assert.deepStrictEqual(d.domains, ['neuf.com']);
  assert.strictEqual(d.amount, 12.99 + 15.99);                                     // 10*1.3 -> 12.99 ; renouvellement 12*1.3=15.6 -> 15.99
  const reg = t.ns.calls.find((c) => c.op === 'registerDomain');
  assert.strictEqual(reg.q.domain, 'neuf.com');
  assert.strictEqual(reg.q.years, '2');
  assert.strictEqual(reg.q.private, '1');
  assert.ok(t.ns.calls.some((c) => c.op === 'domainLock'));
  const mine = await (await t.api('/api/domains')).json();
  assert.strictEqual(mine.domains.length, 1);
  await t.close();
});

test('achat : domaine indisponible ou premium -> 409, aucun paiement, aucun enregistrement', async () => {
  const t = await setup();
  t.state.premium.push('cher.com');
  for (const domain of ['pris.com', 'cher.com']) {
    const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: [domain], years: 1 } });
    assert.strictEqual(r.status, 409, domain);
  }
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'));
  await t.close();
});

test('achat : durée minimale > 1 an (duration) traitée comme indisponible', async () => {
  const t = await setup();
  t.state.longTerm.push('long.com');
  const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['long.com'], years: 1 } });
  assert.strictEqual(r.status, 409);
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'));
  await t.close();
});

test('achat : codes 301/302 = succès (avertissements journalisés), domaine déjà verrouillé (252) toléré, coût réel enregistré', async () => {
  for (const code of [301, 302]) {
    const t = await setup();
    t.state.registerCode = code; t.state.lockCode = 252;
    const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
    assert.strictEqual(r.status, 200, 'code ' + code);
    const mine = await (await t.api('/api/domains')).json();
    assert.strictEqual(mine.domains[0].registrarCost, 10);
    assert.strictEqual(mine.domains[0].autoRenew, false, 'auto_renew=0 chez NameSilo : ne pas promettre un renouvellement automatique inexistant');
    await t.close();
  }
});

test('enregistrement : paramètres conformes à la référence (private=1, auto_renew=0 explicite, ns1-ns13 seulement si ≥ 2)', async () => {
  const one = await setup({ env: { NAMESERVERS: 'ns1.fredaworkspace.com' } });
  await one.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  const q1 = one.ns.calls.find((c) => c.op === 'registerDomain').q;
  assert.strictEqual(q1.private, '1'); assert.strictEqual(q1.auto_renew, '0'); assert.strictEqual(q1.ns1, undefined, 'un seul serveur : ignoré');
  await one.close();
  const two = await setup({ env: { NAMESERVERS: 'ns1.fredaworkspace.com,ns2.fredaworkspace.com' } });
  await two.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  const q2 = two.ns.calls.find((c) => c.op === 'registerDomain').q;
  assert.strictEqual(q2.ns1, 'ns1.fredaworkspace.com'); assert.strictEqual(q2.ns2, 'ns2.fredaworkspace.com');
  await two.close();
});

test('achat : entrées invalides rejetées (nom, extension, durée, quantité)', async () => {
  const t = await setup();
  const bad = [{ domains: ['pas un domaine'] }, { domains: ['a.xyz'] }, { domains: ['a-.com'] }, { domains: ['ok.com'], years: 99 }, { domains: ['ok.com'], years: 1.5 }, { domains: [] }, { domains: ['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com', 'a6.com'] }];
  for (const b of bad) {
    const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', years: 1, ...b } });
    assert.strictEqual(r.status, 400, JSON.stringify(b));
  }
  await t.close();
});

test('achat : paiement refusé -> rien n’est enregistré chez NameSilo', async () => {
  const payments = { name: 'test', async charge() { throw new PaymentError('Carte refusée.'); }, async refund() {} };
  const t = await setup({ payments });
  const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  assert.strictEqual(r.status, 402);
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'));
  await t.close();
});

test('achat : échec d’enregistrement après paiement -> remboursement intégral', async () => {
  const t = await setup();
  t.state.failRegister.push('neuf.com');
  const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(t.refunds.length, 1);
  assert.strictEqual(t.refunds[0].amount, 12.99);
  await t.close();
});

test('achat de deux domaines dont un échoue : remboursement partiel', async () => {
  const t = await setup();
  t.state.failRegister.push('deux.net');
  const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['un.com', 'deux.net'], years: 1 } });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.deepStrictEqual(d.domains, ['un.com']);
  assert.strictEqual(d.failed[0].name, 'deux.net');
  assert.strictEqual(t.refunds[0].amount, 14.99);
  await t.close();
});

test('achat : solde revendeur insuffisant -> 503 sans prélever le client', async () => {
  const t = await setup();
  t.state.balance = 1;
  const r = await t.api('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(t.refunds.length, 0);
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'));
  await t.close();
});

test('idempotence : la même clé ne rachète pas le domaine', async () => {
  const t = await setup();
  const body = { kind: 'domain', domains: ['neuf.com'], years: 1 };
  const a = await (await t.api('/api/checkout', { method: 'POST', headers: { 'Idempotency-Key': 'k1' }, body })).json();
  const b = await (await t.api('/api/checkout', { method: 'POST', headers: { 'Idempotency-Key': 'k1' }, body })).json();
  assert.strictEqual(a.orderId, b.orderId);
  assert.strictEqual(t.ns.calls.filter((c) => c.op === 'registerDomain').length, 1);
  await t.close();
});

test('un domaine déjà acheté ne peut pas l’être deux fois', async () => {
  const t = await setup();
  const body = { kind: 'domain', domains: ['neuf.com'], years: 1 };
  assert.strictEqual((await t.api('/api/checkout', { method: 'POST', body })).status, 200);
  assert.strictEqual((await t.api('/api/checkout', { method: 'POST', body })).status, 409);
  await t.close();
});

test('JWT : signature, expiration et alg=none vérifiés', async () => {
  const secret = 'x'.repeat(40);
  const t = await setup({ env: { AUTH_MODE: 'jwt', JWT_SECRET: secret } });
  const now = Math.floor(Date.now() / 1000);
  const call = (token) => t.api('/api/domains', { headers: { 'X-Demo-User': '', Authorization: token ? 'Bearer ' + token : '' } });
  assert.strictEqual((await call(signJwt({ sub: 'u1', exp: now + 60 }, secret))).status, 200);
  assert.strictEqual((await call(signJwt({ sub: 'u1', exp: now - 60 }, secret))).status, 401);
  assert.strictEqual((await call(signJwt({ sub: 'u1', exp: now + 60 }, 'y'.repeat(40)))).status, 401);
  const none = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from('{"sub":"u1"}').toString('base64url') + '.';
  assert.strictEqual((await call(none)).status, 401);
  assert.strictEqual((await call('')).status, 401);
  await t.close();
});

test('clé API invalide : erreur propre, pas de fuite de la clé', async () => {
  const t = await setup({ env: { NAMESILO_API_KEY: 'mauvaise-cle' } });
  const r = await t.api('/api/domains/search?q=test');
  assert.strictEqual(r.status, 502);
  assert.ok(!JSON.stringify(await r.json()).includes('mauvaise-cle'));
  const { createClient } = require('../src/namesilo');
  await assert.rejects(createClient({ baseUrl: t.cfg.namesilo.baseUrl, key: 'x', timeoutMs: 5000 }).getPrices(), (e) => Number(e.code) === 110 && /Invalid API key/.test(e.detail), 'le code 110 du corps JSON est conservé malgré le HTTP 401');
  await t.close();
});

test('CORS : seules les origines autorisées reçoivent les en-têtes', async () => {
  const t = await setup({ env: { ALLOWED_ORIGINS: 'https://fredaworkspace.com' } });
  const ok = await fetch(t.base + '/api/health', { headers: { Origin: 'https://fredaworkspace.com' } });
  assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://fredaworkspace.com');
  const bad = await fetch(t.base + '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(bad.headers.get('access-control-allow-origin'), null);
  await t.close();
});

test('démarrage sécurisé : refuse achats réels avec faux paiements, clé absente, auth demo en production', () => {
  assert.ok(assertSafe(loadConfig({ NAMESILO_ENV: 'production', NAMESILO_API_KEY: 'k', PAYMENTS_PROVIDER: 'demo', JWT_SECRET: 'x'.repeat(40) })).some((e) => /faux|sans vrai paiement/.test(e)));
  assert.ok(assertSafe(loadConfig({ JWT_SECRET: 'x'.repeat(40) })).some((e) => /NAMESILO_API_KEY/.test(e)));
  assert.ok(assertSafe(loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'demo', NAMESILO_API_KEY: 'k' })).some((e) => /AUTH_MODE/.test(e)));
  assert.deepStrictEqual(assertSafe(loadConfig({ NAMESILO_API_KEY: 'k', JWT_SECRET: 'x'.repeat(40) })), []);
  assert.throws(() => createPayments({ payments: { provider: 'inconnu' } }));
});
