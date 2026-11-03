const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const j = (r) => r.json();
const CODE = 'purelymail_ownership_proof=abc123';

async function withSub(over = {}) {
  const t = await setup({ payments: demoPay, ...over });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly' } });
  return t;
}
const connectExternal = (t) => t.user('/api/domains/connect', { method: 'POST', body: { domain: 'externe.com', mode: 'records' } });

test('vérification du domaine (zone gérée par Freda) : TXT publié automatiquement et une seule fois ; états pending -> dns_ok -> verified', async () => {
  const t = await withSub();
  t.pmState.verifiedTxt = false;
  let r = await j(await t.user('/api/domains/neuf.com/mail-ownership'));
  assert.deepStrictEqual([r.domain, r.external, r.managedByFreda, r.status], ['neuf.com', false, true, 'pending']);
  assert.deepStrictEqual(r.record, { type: 'TXT', name: '@', value: CODE });
  assert.strictEqual(t.db.all("SELECT * FROM dns_records WHERE role = 'OWNERSHIP'").length, 1, 'publié dans la zone');
  assert.ok(t.ns.calls.some((c) => c.op === 'dnsAddRecord' && /ownership/.test(JSON.stringify(c.q))), 'poussé chez NameSilo');
  await t.user('/api/domains/neuf.com/mail-ownership');
  assert.strictEqual(t.db.all("SELECT * FROM dns_records WHERE role = 'OWNERSHIP'").length, 1, 'idempotent');
  t.dnsState.txt['neuf.com'] = [[CODE]];
  assert.strictEqual((await j(await t.user('/api/domains/neuf.com/mail-ownership'))).status, 'dns_ok');
  t.pmState.domains.push('neuf.com');
  assert.strictEqual((await j(await t.user('/api/domains/neuf.com/mail-ownership'))).status, 'verified');
});

test('domaine EXTERNE : l’enregistrement à ajouter est fourni, jamais poussé chez NameSilo ; créer une boîte avant → 409 avec l’enregistrement dans la réponse', async () => {
  const t = await withSub();
  await connectExternal(t);
  const before = t.ns.calls.filter((c) => /^dns/.test(c.op)).length;
  t.pmState.verifiedTxt = false;
  const r = await j(await t.user('/api/domains/externe.com/mail-ownership'));
  assert.deepStrictEqual([r.external, r.managedByFreda, r.status], [true, false, 'pending']);
  assert.deepStrictEqual(r.record, { type: 'TXT', name: '@', value: CODE });
  assert.strictEqual(t.ns.calls.filter((c) => /^dns/.test(c.op)).length, before, 'pas d’appel NameSilo pour un domaine externe');
  const box = await t.user('/api/mailboxes', { method: 'POST', body: { local: 'contact', domain: 'externe.com' } });
  assert.strictEqual(box.status, 409);
  const body = await j(box);
  assert.strictEqual(body.code, 'domain_ownership_required');
  assert.match(body.message, /hébergeur/);
  assert.deepStrictEqual(body.details, { domain: 'externe.com', record: { type: 'TXT', name: '@', value: CODE } });
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM mailboxes').n, 0, 'aucune boîte fantôme');
  t.pmState.verifiedTxt = true;
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'contact', domain: 'externe.com' } })).status, 200, 'une fois le TXT en place, la boîte se crée');
});

test('vérification du domaine : isolation entre comptes, authentification, messagerie non configurée', async () => {
  const t = await withSub();
  assert.strictEqual((await t.as('autre@example.com')('/api/domains/neuf.com/mail-ownership')).status, 404);
  assert.strictEqual((await t.api('/api/domains/neuf.com/mail-ownership')).status, 401);
  assert.strictEqual((await t.user('/api/domains/inconnu.com/mail-ownership')).status, 404);
  const none = await withSub({ env: { PURELYMAIL_API_KEY: '' } });
  assert.strictEqual((await none.user('/api/domains/neuf.com/mail-ownership')).status, 503);
});

test('erreurs 5xx : jamais de « details » exposés', async () => {
  const t = await withSub();
  t.pmState.fail = true;
  const r = await t.user('/api/domains/neuf.com/mail-ownership');
  assert.ok(r.status >= 500); assert.strictEqual((await j(r)).details, undefined);
});
