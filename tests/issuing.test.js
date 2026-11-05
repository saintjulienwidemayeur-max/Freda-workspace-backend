const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { setup, closeAll } = require('./helpers');
const { loadConfig, assertSafe } = require('../src/config');
test.after(closeAll);

const SK = 'sk_test_abc123', WH = 'whsec_secret123';

/** Faux Freda Pay Issuing (api.fredapay.com) : POST /v1/payments, GET /v1/payments/:id. */
async function fakeIssuing() {
  const st = { payments: {}, calls: [], down: false };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      st.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.headers.authorization !== 'Bearer ' + SK) return json(401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } });
      if (st.down) return json(503, { error: { message: 'down' } });
      if (req.method === 'POST' && req.url === '/v1/payments') {
        const b = JSON.parse(body);
        const existing = Object.values(st.payments).find((p) => p.reference === b.reference);
        if (existing) return json(200, existing);
        if (!(b.amount >= 20)) return json(400, { error: { code: 'INVALID_AMOUNT', message: 'Montant minimum : 20 HTG.' } });
        const id = 'pay_' + crypto.randomBytes(6).toString('hex');
        st.payments[id] = { id, reference: b.reference, amount: b.amount, currency: b.currency || 'HTG', method: b.method, status: 'pending', fee: null, net_amount: null, checkout_url: 'https://pay.test/' + id };
        return json(201, st.payments[id]);
      }
      const m = /^\/v1\/payments\/(.+)$/.exec(req.url);
      if (req.method === 'GET' && m) return st.payments[m[1]] ? json(200, st.payments[m[1]]) : json(404, { error: { code: 'NOT_FOUND', message: 'introuvable' } });
      json(404, { error: { message: 'route' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref(); st.url = 'http://127.0.0.1:' + server.address().port; st.server = server;
  return st;
}

async function withIssuing(over = {}) {
  const fake = await fakeIssuing();
  const t = await setup({ env: { PAYMENTS_PROVIDER: 'issuing', FREDA_ISSUING_SECRET_KEY: SK, FREDA_ISSUING_WEBHOOK_SECRET: WH, FREDA_ISSUING_BASE_URL: fake.url, ...over } });
  t.fake = fake;
  return t;
}
const rawPost = (t, raw, sig) => fetch(t.base + '/api/webhooks/issuing', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Freda-Signature': sig } : {}) }, body: raw });
const sign = (raw, key = WH) => 'sha256=' + crypto.createHmac('sha256', key).update(raw).digest('hex');

test('MonCash via Freda Pay Issuing : le paiement est créé en HTG avec la clé secrète, le client est redirigé, la commande reste en attente', async () => {
  const t = await withIssuing();
  const r = await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'moncash' } });
  assert.strictEqual(r.status, 200);
  const o = await r.json();
  assert.strictEqual(o.status, 'pending');
  assert.strictEqual(o.orderStatus, 'awaiting_payment');
  const post = t.fake.calls.find((c) => c.method === 'POST');
  assert.strictEqual(post.auth, 'Bearer ' + SK);
  assert.strictEqual(post.body.method, 'moncash');
  assert.strictEqual(post.body.currency, 'HTG');
  assert.ok(Number.isInteger(post.body.amount) && post.body.amount >= 20, 'montant entier en gourdes');
  assert.ok(/^FP-[0-9A-F]{10}$/.test(post.body.reference));
  assert.match(JSON.stringify(o), /https:\/\/pay\.test\/pay_/, 'redirection vers checkout_url');
});

test('webhook payment.succeeded : signature vérifiée, le paiement est REVÉRIFIÉ chez le fournisseur puis la commande est exécutée (une seule fois)', async () => {
  const t = await withIssuing();
  const o = await (await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'natcash' } })).json();
  const ref = t.fake.calls.find((c) => c.method === 'POST').body.reference;
  const pay = Object.values(t.fake.payments)[0];
  const body = JSON.stringify({ id: 'evt_1', event: 'payment.succeeded', data: { id: pay.id, reference: ref } });
  // signature fausse ou absente : refusé, rien n'est exécuté
  assert.strictEqual((await rawPost(t, body, sign(body, 'whsec_autre'))).status, 400);
  assert.strictEqual((await rawPost(t, body)).status, 400);
  assert.strictEqual((await rawPost(t, body + ' ', sign(body))).status, 400, 'corps modifié');
  assert.strictEqual((await (await t.user('/api/orders/' + o.orderId)).json()).orderStatus, 'awaiting_payment');
  // signature valide mais le fournisseur dit « pending » : on ne fait pas confiance à l'événement
  assert.strictEqual((await rawPost(t, body, sign(body))).status, 200);
  assert.strictEqual((await (await t.user('/api/orders/' + o.orderId)).json()).orderStatus, 'awaiting_payment', 'un événement ne suffit pas');
  // le fournisseur confirme
  pay.status = 'succeeded';
  assert.strictEqual((await rawPost(t, body, sign(body))).status, 200);
  const done = await (await t.user('/api/orders/' + o.orderId)).json();
  assert.strictEqual(done.status, 'succeeded');
  assert.deepStrictEqual(done.domains, ['neuf.com']);
  const gets = t.fake.calls.filter((c) => c.method === 'GET').length;
  assert.strictEqual((await rawPost(t, body, sign(body))).status, 200, 'rejeu : idempotent');
  assert.strictEqual((await (await t.user('/api/orders/' + o.orderId)).json()).status, 'succeeded');
  assert.ok(gets >= 2);
});

test('payment.failed : commande en échec ; montant payé insuffisant : à traiter, jamais exécutée', async () => {
  const t = await withIssuing();
  const o = await (await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'moncash' } })).json();
  const pay = Object.values(t.fake.payments)[0];
  const body = JSON.stringify({ event: 'payment.failed', data: { reference: pay.reference } });
  assert.strictEqual((await rawPost(t, body, sign(body))).status, 200);
  assert.strictEqual((await (await t.user('/api/orders/' + o.orderId)).json()).status, 'failed');

  const t2 = await withIssuing();
  const o2 = await (await t2.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'moncash' } })).json();
  const p2 = Object.values(t2.fake.payments)[0];
  p2.status = 'succeeded'; p2.amount = Math.floor(p2.amount / 2);
  const b2 = JSON.stringify({ event: 'payment.succeeded', data: { reference: p2.reference } });
  assert.strictEqual((await rawPost(t2, b2, sign(b2))).status, 200);
  assert.notStrictEqual((await (await t2.user('/api/orders/' + o2.orderId)).json()).status, 'succeeded', 'payé de moitié : pas de livraison');
});

test('sans secret de webhook ou hors fournisseur « issuing » : la route n’existe pas ; erreurs du fournisseur -> message clair, commande en échec', async () => {
  const demo = await setup({});
  assert.strictEqual((await rawPost(demo, '{}', 'sha256=00')).status, 404);
  const t = await withIssuing({ FREDA_ISSUING_WEBHOOK_SECRET: '' });
  assert.strictEqual((await rawPost(t, '{}', 'sha256=00')).status, 404);
  const bad = await withIssuing({ FREDA_ISSUING_SECRET_KEY: 'sk_test_mauvaise' });
  // le faux serveur refuse cette clé (401) : message générique, pas de détail technique
  const r = await bad.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'moncash' } });
  assert.ok(r.status >= 400);
  assert.ok(!JSON.stringify(await r.json()).includes('bad key'));
  const down = await withIssuing();
  down.fake.down = true;
  const d = await down.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'moncash' } });
  assert.strictEqual(d.status, 502);
});

test('configuration : clé invalide, secret de webhook invalide, clé de TEST avec NameSilo en live -> démarrage refusé', () => {
  const base = { NAMESILO_API_KEY: 'k', AUTH_MODE: 'demo', PAYMENTS_PROVIDER: 'issuing' };
  const errs = (env) => assertSafe(loadConfig({ ...base, ...env }));
  assert.ok(errs({}).join().includes('FREDA_ISSUING_SECRET_KEY'));
  assert.ok(errs({ FREDA_ISSUING_SECRET_KEY: 'pk_live_x' }).join().includes('invalide'));
  assert.ok(errs({ FREDA_ISSUING_SECRET_KEY: SK, FREDA_ISSUING_WEBHOOK_SECRET: 'abc' }).join().includes('FREDA_ISSUING_WEBHOOK_SECRET'));
  assert.ok(errs({ FREDA_ISSUING_SECRET_KEY: SK, NAMESILO_MODE: 'live' }).join().includes('TEST'));
  assert.deepStrictEqual(errs({ FREDA_ISSUING_SECRET_KEY: SK, FREDA_ISSUING_WEBHOOK_SECRET: WH }), []);
  assert.deepStrictEqual(errs({ FREDA_ISSUING_SECRET_KEY: 'sk_live_x', FREDA_ISSUING_WEBHOOK_SECRET: WH, NAMESILO_MODE: 'live' }), []);
});
