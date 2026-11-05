const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const TOKEN = 'a'.repeat(32);
const adm = (t, path, opts = {}) => t.api(path, { ...opts, headers: { Authorization: 'Bearer ' + (opts.token || TOKEN), ...(opts.headers || {}) } });
const put = (t, body, token) => adm(t, '/api/admin/pricing', { method: 'PUT', body, token });
const comPrice = async (t) => (await (await t.api('/api/domains/search?q=exemple.com')).json()).exact.price;

test('marge modifiable : lecture, aperçu sans enregistrer, enregistrement, effet immédiat sur les prix clients, retour aux valeurs par défaut', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  assert.strictEqual((await t.api('/api/admin/pricing')).status, 401, 'réservé à l’administrateur');
  assert.strictEqual((await put(t, { markupPercent: 50, minMarkup: 1 }, 'b'.repeat(32))).status, 401);
  assert.strictEqual((await t.user('/api/admin/pricing', { method: 'PUT', body: { markupPercent: 99, minMarkup: 1 } })).status, 401, 'un client ne peut jamais changer les prix');

  const cur = await (await adm(t, '/api/admin/pricing')).json();
  assert.strictEqual(cur.markupPercent, 30, 'valeur par défaut (variable d’environnement)');
  assert.strictEqual(cur.custom, false);
  assert.deepStrictEqual(cur.defaults, { markupPercent: 30, minMarkup: 1.5 });
  const com = cur.tlds.find((x) => x.tld === '.com');
  assert.strictEqual(com.cost, 10);
  const before = await comPrice(t);
  assert.strictEqual(before, com.price);

  // aperçu : montre les nouveaux prix mais ne change rien
  const prev = await (await adm(t, '/api/admin/pricing?markupPercent=100&minMarkup=1')).json();
  assert.strictEqual(prev.tlds.find((x) => x.tld === '.com').price, 19.99, '10 $ + 100 % = 20 $ -> x.99');
  assert.strictEqual(prev.custom, false);
  assert.strictEqual(await comPrice(t), before, 'l’aperçu n’enregistre rien');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM app_settings')).n, 0);

  // enregistrement : les prix clients changent aussitôt
  const saved = await put(t, { markupPercent: 100, minMarkup: 2 });
  assert.strictEqual(saved.status, 200);
  const sb = await saved.json();
  assert.deepStrictEqual([sb.markupPercent, sb.minMarkup, sb.custom], [100, 2, true]);
  assert.strictEqual(await comPrice(t), 19.99);
  assert.strictEqual((await (await adm(t, '/api/admin/domain-prices')).json()).markupPercent, 100, 'l’ancienne route voit la nouvelle marge');
  assert.strictEqual((await (await adm(t, '/api/admin/pricing')).json()).custom, true);

  // retour aux valeurs par défaut
  const back = await (await put(t, { reset: true })).json();
  assert.deepStrictEqual([back.markupPercent, back.minMarkup, back.custom], [30, 1.5, false]);
  assert.strictEqual(await comPrice(t), before);
});

test('marge : valeurs invalides refusées (400), bornes respectées, virgule décimale acceptée, une commande déjà créée garde son prix', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  for (const bad of [{ markupPercent: -1, minMarkup: 1 }, { markupPercent: 301, minMarkup: 1 }, { markupPercent: 'abc', minMarkup: 1 }, { markupPercent: 30, minMarkup: 51 }, { markupPercent: 30 }, { markupPercent: null, minMarkup: 1 }, {}]) {
    const r = await put(t, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.strictEqual((await r.json()).code, 'invalid_pricing');
  }
  assert.strictEqual((await adm(t, '/api/admin/pricing?markupPercent=abc')).status, 400);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM app_settings')).n, 0, 'rien d’enregistré après un refus');
  assert.strictEqual((await put(t, { markupPercent: '45,5', minMarkup: '0' })).status, 200);
  const cur = await (await adm(t, '/api/admin/pricing')).json();
  assert.deepStrictEqual([cur.markupPercent, cur.minMarkup], [45.5, 0]);
  // le prix d'une commande déjà créée ne bouge pas quand la marge change ensuite
  const demoPay = { name: 'test', async create() { return { status: 'pending', providerRef: 'x', redirectUrl: 'https://pay.test/x' }; }, async verify() { return { status: 'pending' }; }, async refund() {} };
  const t2 = await setup({ payments: demoPay, env: { ADMIN_TOKEN: TOKEN } });
  const o = await (await t2.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'moncash' } })).json();
  const amount = o.amount;
  assert.strictEqual((await put(t2, { markupPercent: 200, minMarkup: 1 })).status, 200);
  assert.strictEqual((await t2.db.get('SELECT amount FROM orders WHERE id = ?', o.orderId)).amount, amount);
  const o2 = await (await t2.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['autre.com'], years: 1, method: 'moncash' } })).json();
  assert.ok(o2.amount > amount, 'les nouvelles commandes suivent la nouvelle marge');
});
