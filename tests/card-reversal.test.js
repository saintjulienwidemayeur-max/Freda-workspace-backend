const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const sign = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
const hook = (t, payload) => { const body = JSON.stringify(payload); return t.api('/api/webhooks/stripe', { method: 'POST', headers: { 'Stripe-Signature': sign(body) }, body: payload }); };
const buy = (t, body) => t.user('/api/checkout', { method: 'POST', body });
const balanceOf = async (t) => (await (await t.user('/api/balance')).json()).balance;
const status = async (t, id) => { await t.db.run('UPDATE orders SET last_check = 0'); return (await t.user('/api/orders/' + id)).json(); };

/** Recharge de 20 $ payée par carte, confirmée. */
async function paidTopup(t, amount = 20) {
  const r = await (await buy(t, { kind: 'topup', amount, method: 'card' })).json();
  const o = await t.db.get('SELECT charge_id FROM orders WHERE id = ?', r.orderId);
  t.stState.sessions[o.charge_id].payment_status = 'paid';
  assert.strictEqual((await status(t, r.orderId)).status, 'succeeded');
  assert.strictEqual(await balanceOf(t), amount);
  return r;
}
const withStripe = () => setup({ env: { PAYMENTS_PROVIDER: 'paym' }, stripe: true });

test('litige carte sur une recharge : le crédit est repris (solde négatif), une seule fois, plus aucun achat avec le solde', async () => {
  const t = await withStripe();
  const r = await paidTopup(t, 20);
  t.stState.pis['pi_litige'] = { id: 'pi_litige', metadata: { reference: r.reference } };   // le litige ne porte pas nos métadonnées : relues sur le PaymentIntent
  const ev = { id: 'evt_d1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', amount: 2200, payment_intent: 'pi_litige' } } };
  assert.strictEqual((await hook(t, ev)).status, 200);
  assert.strictEqual(await balanceOf(t), 0, 'recharge reprise');
  assert.strictEqual((await hook(t, ev)).status, 200);
  assert.strictEqual(await balanceOf(t), 0, 'rejeu : jamais repris deux fois');
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM balance_entries WHERE kind = 'card_reversal'")).n, 1);
  const buyWithBalance = await buy(t, { kind: 'subscription', plan: 'starter', cycle: 'monthly', method: 'balance' });
  assert.strictEqual(buyWithBalance.status, 402, 'solde insuffisant après le litige');
});

test('litige après dépense du solde : le solde devient négatif, aucun nouvel achat', async () => {
  const t = await withStripe();
  const r = await paidTopup(t, 10);
  assert.strictEqual((await buy(t, { kind: 'subscription', plan: 'starter', cycle: 'monthly', method: 'balance' })).status, 200);   // 2,99 $ dépensés
  t.stState.pis['pi_x'] = { id: 'pi_x', metadata: { reference: r.reference } };
  await hook(t, { id: 'evt_d2', type: 'charge.dispute.created', data: { object: { id: 'dp_2', payment_intent: 'pi_x' } } });
  assert.strictEqual(await balanceOf(t), -2.99, '10 $ repris, 7,01 $ restants -> -2,99 $');
  assert.strictEqual((await buy(t, { kind: 'subscription', plan: 'business', cycle: 'monthly', method: 'balance' })).status, 402);
});

test('remboursement carte : partiel puis total, la reprise ne fait que monter ; métadonnées du charge utilisées sans appel supplémentaire', async () => {
  const t = await withStripe();
  const r = await paidTopup(t, 20);
  const charge = (refunded) => ({ id: 'evt_r' + refunded, type: 'charge.refunded', data: { object: { amount: 2200, amount_refunded: refunded, metadata: { reference: r.reference } } } });
  await hook(t, charge(1100));
  assert.strictEqual(await balanceOf(t), 10, 'moitié remboursée -> moitié reprise');
  await hook(t, charge(1100));
  assert.strictEqual(await balanceOf(t), 10, 'même événement rejoué : rien de plus');
  await hook(t, charge(2200));
  assert.strictEqual(await balanceOf(t), 0, 'remboursement complet');
  assert.ok(!t.stripe.calls.some((x) => /payment_intents\/pi_/.test(x.path)), 'référence lue dans les métadonnées du charge');
});

test('litige sur une commande exécutée (domaine) : alerte, rien n’est repris automatiquement ; remboursement de notre propre fait ignoré', async () => {
  const t = await withStripe();
  const r = await (await buy(t, { kind: 'domain', years: 1, method: 'card', domains: ['neuf.com'] })).json();
  t.stState.sessions[(await t.db.get('SELECT charge_id FROM orders WHERE id = ?', r.orderId)).charge_id].payment_status = 'paid';
  assert.strictEqual((await status(t, r.orderId)).status, 'succeeded');
  await hook(t, { id: 'evt_r', type: 'charge.refunded', data: { object: { amount: 1384, amount_refunded: 1384, metadata: { reference: r.reference } } } });
  assert.strictEqual(await balanceOf(t), 0);
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM balance_entries WHERE kind = 'card_reversal'")).n, 0);
  assert.strictEqual((await hook(t, { id: 'evt_d', type: 'charge.dispute.created', data: { object: { id: 'dp', metadata: { reference: r.reference } } } })).status, 200);
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM balance_entries WHERE kind = 'card_reversal'")).n, 0, 'domaine déjà acheté : traitement manuel, pas de débit automatique');
});

test('référence inconnue ou signature invalide : aucun effet', async () => {
  const t = await withStripe();
  assert.strictEqual((await hook(t, { id: 'e', type: 'charge.dispute.created', data: { object: { metadata: { reference: 'FP-INCONNU' } } } })).status, 200);
  assert.strictEqual((await t.api('/api/webhooks/stripe', { method: 'POST', headers: { 'Stripe-Signature': 'junk' }, body: { type: 'charge.dispute.created' } })).status, 400);
});

test('paiement confirmé sans montant attendu enregistré : jamais exécuté (needs_attention), même si le fournisseur dit « payé »', async () => {
  const t = await withStripe();
  const r = await paidTopupNoExecute(t);
  async function paidTopupNoExecute(tt) {
    const rr = await (await buy(tt, { kind: 'topup', amount: 20, method: 'card' })).json();
    const o = await tt.db.get('SELECT payload, charge_id FROM orders WHERE id = ?', rr.orderId);
    const p = JSON.parse(o.payload); delete p.amountCents; delete p.amountHtg;
    await tt.db.run('UPDATE orders SET payload = ? WHERE id = ?', JSON.stringify(p), rr.orderId);
    tt.stState.sessions[o.charge_id].payment_status = 'paid';
    return rr;
  }
  assert.strictEqual((await status(t, r.orderId)).orderStatus, 'needs_attention');
  assert.strictEqual(await balanceOf(t), 0, 'aucun crédit');
});
