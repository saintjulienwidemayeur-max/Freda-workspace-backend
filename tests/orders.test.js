const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const payBody = (b) => ({ kind: 'domain', years: 1, method: 'moncash', ...b });
const checkout = (t, body, headers) => t.user('/api/checkout', { method: 'POST', body, headers });
const order = async (t, id) => (await t.user('/api/orders/' + id)).json();
const withPaym = async () => (await setup({ env: { PAYMENTS_PROVIDER: 'paym' } }));

test('Pay’m : la commande reste en attente avec l’URL de paiement ; montant HTG envoyé = prix serveur × taux (arrondi au-dessus)', async () => {
  const t = await withPaym();
  const r = await (await checkout(t, payBody({ domains: ['neuf.com'], amount: 0.01 }))).json();
  assert.strictEqual(r.status, 'pending');
  assert.match(r.redirectUrl, /^https:\/\/pay\.test\/pay\/FP-/);
  const call = t.paym.calls.find((c) => c.path === '/api/paiement-marchand').body;
  assert.strictEqual(call.client_id, 'cid');
  assert.strictEqual(call.payment_method, 'moncash');
  assert.strictEqual(call.montant, Math.ceil((12.99 + 0.78) * 132));
  assert.strictEqual(call.refference_id, r.reference);
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'), 'rien n’est acheté avant le paiement');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM domains')).n, 0);
});

test('Pay’m : tant que le client n’a pas payé, la commande reste « pending » ; une fois payée, elle s’exécute une seule fois', async () => {
  const t = await withPaym();
  const r = await (await checkout(t, payBody({ domains: ['neuf.com'] }))).json();
  assert.strictEqual((await order(t, r.orderId)).status, 'pending');
  t.state.paid.add(r.reference);
  await t.db.run('UPDATE orders SET last_check = 0');
  const done = await order(t, r.orderId);
  assert.strictEqual(done.status, 'succeeded');
  assert.deepStrictEqual(done.domains, ['neuf.com']);
  await t.db.run('UPDATE orders SET last_check = 0');
  await order(t, r.orderId);
  assert.strictEqual(t.ns.calls.filter((c) => c.op === 'registerDomain').length, 1, 'jamais deux enregistrements');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM invoices')).n, 1);
});

test('Pay’m : le balayage confirme le paiement même si le client a fermé la page', async () => {
  const t = await withPaym();
  const r = await (await checkout(t, payBody({ domains: ['neuf.com'] }))).json();
  t.state.paid.add(r.reference);
  const s = await t.app.app.orders.sweep();
  assert.strictEqual(s.checked, 1);
  assert.strictEqual((await t.db.get('SELECT status FROM orders')).status, 'completed');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM domains')).n, 1);
});

test('Pay’m : commande expirée après 2 h sans paiement ; montant payé insuffisant -> needs_attention + alerte', async () => {
  const t = await withPaym();
  const a = await (await checkout(t, payBody({ domains: ['un.com'] }))).json();
  await t.db.run("UPDATE orders SET created_at = ? WHERE id = ?", new Date(Date.now() - 3 * 3600 * 1000).toISOString(), a.orderId);
  await t.app.app.orders.sweep();
  assert.strictEqual((await t.db.get('SELECT status FROM orders WHERE id = ?', a.orderId)).status, 'expired');
  const b = await (await checkout(t, payBody({ domains: ['deux.com'] }))).json();
  t.state.paid.add(b.reference); t.state.paidAmount[b.reference] = 100;
  await t.app.app.orders.sweep();
  assert.strictEqual((await t.db.get('SELECT status FROM orders WHERE id = ?', b.orderId)).status, 'needs_attention');
  assert.ok(!t.ns.calls.some((c) => c.op === 'registerDomain'));
});

test('Pay’m : échec d’enregistrement après paiement -> remboursement automatique sur le SOLDE du client (aucun remboursement manuel)', async () => {
  const alerts = [];
  const t = await setup({ env: { PAYMENTS_PROVIDER: 'paym' }, deps: { alert: async (...a) => alerts.push(a) } });
  t.state.failRegister.push('neuf.com');
  const r = await (await checkout(t, payBody({ domains: ['neuf.com'] }))).json();
  t.state.paid.add(r.reference);
  await t.app.app.orders.sweep();
  assert.strictEqual((await t.db.get('SELECT status FROM orders')).status, 'refunded');
  assert.ok(!alerts.some(([, m]) => /MANUELLEMENT/.test(m)), 'plus de remboursement manuel');
  const e = await t.db.all("SELECT amount, kind FROM balance_entries");
  assert.deepStrictEqual(e.map((x) => x.kind), ['refund']);
  assert.strictEqual(e[0].amount, 12.99, 'le client retrouve exactement le prix payé sur son solde');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM invoices')).n, 0, 'pas de facture pour un achat non livré');
});

test('Pay’m indisponible -> 502 et commande marquée payment_failed ; carte -> 501', async () => {
  const t = await withPaym();
  t.state.paymDown = true;
  assert.strictEqual((await checkout(t, payBody({ domains: ['neuf.com'] }))).status, 502);
  assert.strictEqual((await t.db.get('SELECT status FROM orders')).status, 'payment_failed');
  t.state.paymDown = false;
  assert.strictEqual((await checkout(t, payBody({ domains: ['autre.com'], method: 'card' }))).status, 501);
});

test('un domaine en cours d’achat ne peut pas être commandé deux fois', async () => {
  const t = await withPaym();
  assert.strictEqual((await checkout(t, payBody({ domains: ['neuf.com'] }))).status, 200);
  assert.strictEqual((await checkout(t, payBody({ domains: ['neuf.com'] }))).status, 409);
});

test('isolation : un autre compte ne voit pas la commande', async () => {
  const t = await withPaym();
  const r = await (await checkout(t, payBody({ domains: ['neuf.com'] }))).json();
  assert.strictEqual((await t.as('autre@example.com')('/api/orders/' + r.orderId)).status, 404);
});

/* ---------- Offre Freda Mail ---------- */
const buyDomain = async (t) => { const r = await (await checkout(t, payBody({ domains: ['neuf.com'] }))).json(); t.state.paid.add(r.reference); await t.app.app.orders.sweep(); };

test('offre Freda Mail : prix serveur (mensuel / annuel = 10 mois), abonnement, zone e-mail, première boîte, facture, mot de passe par e-mail', async () => {
  const t = await withPaym();
  await buyDomain(t);
  const s = await (await checkout(t, { kind: 'subscription', plan: 'business', cycle: 'yearly', domain: 'neuf.com', mailbox: { local: 'contact', name: 'Accueil' }, method: 'natcash', amount: 1 })).json();
  assert.strictEqual(s.amount, 99.9);
  t.state.paid.add(s.reference);
  await t.app.app.orders.sweep();
  const w = await (await t.user('/api/workspace')).json();
  assert.strictEqual(w.plan.id, 'business'); assert.strictEqual(w.plan.cycle, 'yearly'); assert.strictEqual(w.plan.status, 'active');
  assert.strictEqual(w.dns['neuf.com'].filter((r) => r.managed && r.role !== 'OWNERSHIP').length, 6, 'enregistrements e-mail ajoutés');
  assert.strictEqual(w.mailboxes[0].address, 'contact@neuf.com');
  assert.ok(w.invoices.some((i) => i.label === 'Business — annuel' && i.amount === 99.9));
  const pwMail = t.mailer.sent.find((m) => /première boîte/.test(m.subject));
  assert.ok(pwMail && /Mot de passe initial : \S{10,}/.test(pwMail.text));
  const create = t.pm.calls.find((c) => c.path.endsWith('/createUser'));
  assert.strictEqual(create.token, 'pm-key'); assert.strictEqual(create.body.userName, 'contact'); assert.strictEqual(create.body.domainName, 'neuf.com');
});

test('offre : plan inconnu, cycle inconnu, domaine d’un autre compte refusés', async () => {
  const t = await withPaym();
  assert.strictEqual((await checkout(t, { kind: 'subscription', plan: 'gratuit', cycle: 'monthly' })).status, 400);
  assert.strictEqual((await checkout(t, { kind: 'subscription', plan: 'starter', cycle: 'weekly' })).status, 400);
  assert.strictEqual((await checkout(t, { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'pas-a-moi.com' })).status, 400);
});

/* ---------- Renouvellement ---------- */
test('renouvellement : prix de renouvellement serveur, NameSilo renewDomain, expiration prolongée, facture', async () => {
  const t = await withPaym();
  await buyDomain(t);
  const before = (await t.db.get('SELECT expires_at FROM domains')).expires_at;
  const r = await (await checkout(t, { kind: 'renewal', domain: 'neuf.com', years: 2, method: 'moncash' })).json();
  assert.strictEqual(r.amount, 15.99 * 2);
  assert.strictEqual((await checkout(t, { kind: 'renewal', domain: 'neuf.com', years: 1 })).status, 409, 'un seul renouvellement en attente');
  t.state.paid.add(r.reference);
  await t.app.app.orders.sweep();
  const q = t.ns.calls.find((c) => c.op === 'renewDomain').q;
  assert.deepStrictEqual([q.domain, q.years], ['neuf.com', '2']);
  const after = (await t.db.get('SELECT expires_at FROM domains')).expires_at;
  assert.strictEqual(Number(after.slice(0, 4)) - Number(before.slice(0, 4)), 2);
  assert.ok(await t.db.get("SELECT 1 FROM invoices WHERE label LIKE 'Renouvellement neuf.com%'"));
});

test('renouvellement payé mais refusé par NameSilo -> needs_attention + e-mail client + alerte', async () => {
  const alerts = [];
  const t = await setup({ env: { PAYMENTS_PROVIDER: 'paym' }, deps: { alert: async (...a) => alerts.push(a) } });
  await buyDomain(t);
  t.state.failRenew = true;
  const r = await (await checkout(t, { kind: 'renewal', domain: 'neuf.com', years: 1, method: 'moncash' })).json();
  t.state.paid.add(r.reference);
  await t.app.app.orders.sweep();
  assert.strictEqual((await t.db.get('SELECT status FROM orders WHERE id = ?', r.orderId)).status, 'needs_attention');
  assert.ok(alerts.some(([, m]) => /Renouvellement payé mais échoué/.test(m)));
  assert.ok(t.mailer.sent.some((m) => /n'a pas pu être renouvelé/.test(m.subject)));
});

test('renouvellement : domaine inconnu ou externe refusé', async () => {
  const t = await withPaym();
  assert.strictEqual((await checkout(t, { kind: 'renewal', domain: 'inconnu.com' })).status, 404);
  await t.user('/api/domains/connect', { method: 'POST', body: { domain: 'externe.com', mode: 'records' } });
  assert.strictEqual((await checkout(t, { kind: 'renewal', domain: 'externe.com' })).status, 404);
});

test('numéros de facture : uniques même quand plusieurs paiements sont confirmés en même temps', async () => {
  const t = await withPaym();
  const refs = [];
  for (const d of ['un.com', 'deux.com', 'trois.com', 'quatre.com', 'cinq.com']) {
    const r = await (await checkout(t, payBody({ domains: [d] }))).json();
    t.state.paid.add(r.reference); refs.push(r.orderId);
  }
  await t.db.run('UPDATE orders SET last_check = 0');
  await Promise.all(refs.map((id) => t.user('/api/orders/' + id)));       // 5 confirmations parallèles
  const ids = (await t.db.all('SELECT id FROM invoices ORDER BY id')).map((r) => r.id);
  assert.strictEqual(ids.length, 5);
  assert.strictEqual(new Set(ids).size, 5, 'aucun doublon : ' + ids.join(', '));
  assert.match(ids[0], /^FW-\d{4}-0001$/);
});
