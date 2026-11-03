const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup, closeAll } = require('./helpers');
const { verifySignature, form } = require('../src/stripe');
const { loadConfig, assertSafe } = require('../src/config');
test.after(closeAll);

const withStripe = async (over = {}) => (await setup({ env: { PAYMENTS_PROVIDER: 'paym' }, stripe: true, ...over }));
const checkout = (t, body) => t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', years: 1, method: 'card', domains: ['neuf.com'], ...body } });
const status = async (t, id) => { await t.db.run('UPDATE orders SET last_check = 0'); return (await t.user('/api/orders/' + id)).json(); };
const sign = (body, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const webhook = (t, payload, sig) => { const body = JSON.stringify(payload); return t.api('/api/webhooks/stripe', { method: 'POST', headers: { 'Stripe-Signature': sig === undefined ? sign(body) : sig }, body: payload }); };
const completed = (ref) => ({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: ref } } });
const payAndComplete = async (t, r) => { t.stState.sessions[(await t.db.get('SELECT charge_id FROM orders WHERE id = ?', r.orderId)).charge_id].payment_status = 'paid'; };

test('carte : Checkout hébergé avec carte enregistrée pour plus tard, montant en cents calculé côté serveur, aucune donnée de carte chez nous', async () => {
  const t = await withStripe();
  const r = await (await checkout(t, { amount: 0.01 })).json();
  assert.strictEqual(r.status, 'pending');
  assert.match(r.redirectUrl, /^https:\/\/checkout\.stripe\.test\/cs_/);
  const c = t.stripe.calls.find((x) => x.path === '/v1/checkout/sessions');
  assert.strictEqual(c.f['line_items[0][price_data][unit_amount]'], '1299', 'prix serveur (12,99 $) en cents, pas le 0,01 du navigateur');
  assert.strictEqual(c.f['payment_method_options[card][setup_future_usage]'], 'off_session', 'seule la carte est enregistrée pour les prélèvements');
  assert.ok(!Object.keys(c.f).some((k) => k.startsWith('payment_method_types')), 'aucune liste figée : Checkout propose tous les moyens activés au Dashboard');
  assert.ok(!('payment_method_configuration' in c.f), 'configuration par défaut du compte');
  assert.strictEqual(c.idem, 'cs-' + r.reference, 'clé d’idempotence = référence');
  assert.ok(c.f.success_url.includes('payment=success') && c.f.success_url.includes('order=' + r.orderId), 'retour Stripe : la page sait quelle commande confirmer');
  assert.ok(c.f.cancel_url.includes('payment=cancelled') && c.f.cancel_url.includes('order=' + r.orderId));
  assert.strictEqual(t.stripe.calls.filter((x) => x.path === '/v1/customers').length, 1);
  assert.ok(!t.ns.calls.some((x) => x.op === 'registerDomain'), 'rien n’est acheté avant le paiement');
  assert.strictEqual((await t.user('/api/payment-methods', { method: 'POST', body: { type: 'card', number: '4242424242424242' } })).status, 400, 'jamais de numéro de carte via notre API');
});

test('carte : webhook signé -> commande exécutée une seule fois, carte enregistrée par défaut (marque, 4 derniers chiffres, expiration)', async () => {
  const t = await withStripe();
  const r = await (await checkout(t, {})).json();
  assert.strictEqual((await status(t, r.orderId)).status, 'pending', 'pas payé : toujours en attente');
  await payAndComplete(t, r);
  assert.strictEqual((await webhook(t, completed(r.reference))).status, 200);
  assert.strictEqual((await webhook(t, completed(r.reference))).status, 200, 'webhook rejoué : idempotent');
  assert.strictEqual(t.ns.calls.filter((x) => x.op === 'registerDomain').length, 1);
  assert.strictEqual((await status(t, r.orderId)).status, 'succeeded');
  const m = (await (await t.user('/api/payment-methods')).json()).methods;
  assert.deepStrictEqual(m.map((x) => [x.type, x.brand, x.last4, x.exp, x.default]), [['card', 'visa', '4242', '04/31', true]]);
  assert.strictEqual(t.stripe.calls.filter((x) => x.path === '/v1/customers').length, 1, 'un seul client Stripe par compte');
});

test('webhook : signature invalide, mauvais secret, horodatage trop ancien -> 400 ; événement signé mais paiement non reçu -> rien n’est exécuté', async () => {
  const t = await withStripe();
  const r = await (await checkout(t, {})).json();
  assert.strictEqual((await webhook(t, completed(r.reference), 'junk')).status, 400);
  assert.strictEqual((await webhook(t, completed(r.reference), sign(JSON.stringify(completed(r.reference)), 'whsec_autre'))).status, 400);
  assert.strictEqual((await webhook(t, completed(r.reference), sign(JSON.stringify(completed(r.reference)), 'whsec_test', Math.floor(Date.now() / 1000) - 3600))).status, 400);
  assert.strictEqual((await t.api('/api/webhooks/stripe', { method: 'POST', body: completed(r.reference) })).status, 400, 'sans en-tête');
  assert.strictEqual((await webhook(t, completed(r.reference))).status, 200);
  assert.ok(!t.ns.calls.some((x) => x.op === 'registerDomain'), 'événement forgé : la vérification chez Stripe fait foi');
  assert.strictEqual((await status(t, r.orderId)).status, 'pending');
});

test('carte enregistrée : second achat sans action du client (off_session), puis authentification exigée -> bascule vers Checkout, refus -> 402', async () => {
  const t = await withStripe();
  const first = await (await checkout(t, {})).json();
  await payAndComplete(t, first); await status(t, first.orderId);
  const methodId = (await (await t.user('/api/payment-methods')).json()).methods[0].id;
  const second = await (await checkout(t, { domains: ['deux.com'], methodId })).json();
  assert.strictEqual(second.status, 'succeeded', 'débité immédiatement');
  const pi = t.stripe.calls.find((x) => x.path === '/v1/payment_intents');
  assert.deepStrictEqual([pi.f.off_session, pi.f.confirm, pi.f.amount, pi.f.currency], ['true', 'true', '1299', 'usd']);
  assert.strictEqual(pi.idem, 'pi-' + second.reference);
  t.stState.authRequired = true;
  const third = await (await checkout(t, { domains: ['trois.com'], methodId })).json();
  assert.strictEqual(third.status, 'pending', '3-D Secure : le client finit sur la page Stripe');
  assert.match(third.redirectUrl, /checkout\.stripe\.test/);
  t.stState.authRequired = false; t.stState.decline = true;
  const refused = await checkout(t, { domains: ['quatre.com'], methodId });
  assert.strictEqual(refused.status, 402);
  assert.match((await refused.json()).message, /Carte refusée/);
  assert.ok(!t.ns.calls.some((x) => x.op === 'registerDomain' && x.domain === 'quatre.com'));
});

async function dueSubscription(t) {
  const first = await (await checkout(t, {})).json();
  await payAndComplete(t, first); await status(t, first.orderId);
  const sub = await checkout(t, { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'neuf.com', methodId: (await (await t.user('/api/payment-methods')).json()).methods[0].id });
  assert.strictEqual((await sub.json()).status, 'succeeded');
  const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await t.db.run('UPDATE subscriptions SET renews_at = ?', past);
  return past;
}

test('abonnement échu : prélevé automatiquement sur la carte enregistrée, prolongé, jamais deux fois pour la même période', async () => {
  const t = await withStripe();
  const past = await dueSubscription(t);
  const charges = () => t.stripe.calls.filter((x) => x.path === '/v1/payment_intents').length;
  const before = charges();
  await t.app.app.jobs.run();
  assert.strictEqual(charges(), before + 1);
  const s = await t.db.get('SELECT * FROM subscriptions');
  assert.ok(s.renews_at > past && s.status === 'active', 'prolongé, pas « past_due »');
  assert.ok(!t.mailer.sent.some((m) => /à régler/.test(m.subject)), 'aucun rappel de paiement : déjà renouvelé');
  await t.app.app.jobs.run(); await t.app.app.jobs.run();
  assert.strictEqual(charges(), before + 1, 'pas de double débit');
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM invoices WHERE label LIKE '%Starter%'")).n, 2);
});

test('abonnement échu, carte refusée : 3 tentatives maximum (échéance, +3 j, +5 j), puis past_due et e-mail au client', async () => {
  const t = await withStripe();
  await dueSubscription(t);
  t.stState.decline = true;
  const tries = () => t.stripe.calls.filter((x) => x.path === '/v1/payment_intents').length;
  const base = tries();
  await t.app.app.jobs.run(); await t.app.app.jobs.run();
  assert.strictEqual(tries(), base + 1, 'une tentative par palier, pas une par exécution');
  assert.strictEqual((await t.db.get('SELECT status FROM subscriptions')).status, 'past_due');
  assert.ok(t.mailer.sent.some((m) => /à régler/.test(m.subject)), 'le client est prévenu');
  await t.db.run('UPDATE subscriptions SET renews_at = ?', new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10)); await t.app.app.jobs.run();
  await t.db.run('UPDATE subscriptions SET renews_at = ?', new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)); await t.app.app.jobs.run();
  await t.db.run('UPDATE subscriptions SET renews_at = ?', new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)); await t.app.app.jobs.run();
  assert.strictEqual(tries(), base + 3);
  t.stState.decline = false;
  await t.db.run('UPDATE subscriptions SET renews_at = ?', new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)); await t.app.app.jobs.run();
  assert.strictEqual(tries(), base + 3, 'plus aucune tentative après la troisième');
});

test('abonnement échu sans carte enregistrée (MonCash) : aucun prélèvement, rappels habituels', async () => {
  const t = await withStripe();
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', method: 'moncash' } });
  const r = await t.db.get('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1'); t.state.paid.add(r.reference); await status(t, r.id);
  await t.db.run('UPDATE subscriptions SET renews_at = ?', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  await t.app.app.jobs.run();
  assert.ok(!t.stripe.calls.some((x) => x.path === '/v1/payment_intents'));
  assert.strictEqual((await t.db.get('SELECT status FROM subscriptions')).status, 'past_due');
});

test('remboursement par carte : l’enregistrement échoue après paiement -> remboursé chez Stripe (payment_intent), sans intervention manuelle', async () => {
  const t = await withStripe();
  t.state.failRegister = ['neuf.com'];
  const r = await (await checkout(t, {})).json();
  await payAndComplete(t, r);
  const res = await webhook(t, completed(r.reference));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(t.stState.refunds.length, 1);
  assert.match(t.stState.refunds[0].payment_intent, /^pi_cs_/);
  assert.strictEqual((await t.db.get('SELECT status FROM orders')).status, 'refunded');
});

test('carte supprimée par le client : détachée chez Stripe et plus jamais débitée', async () => {
  const t = await withStripe();
  const r = await (await checkout(t, {})).json(); await payAndComplete(t, r); await status(t, r.orderId);
  const m = (await (await t.user('/api/payment-methods')).json()).methods[0];
  assert.strictEqual((await t.user('/api/payment-methods/' + m.id, { method: 'DELETE' })).status, 200);
  assert.deepStrictEqual(t.stState.detached, ['pm_card1']);
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM payment_methods WHERE type = 'card'")).n, 0);
});

test('sans clé Stripe : la carte reste indisponible (501) et le webhook n’existe pas ; MonCash intact', async () => {
  const t = await setup({ env: { PAYMENTS_PROVIDER: 'paym' } });
  assert.strictEqual((await checkout(t, {})).status, 501);
  assert.strictEqual((await t.api('/api/webhooks/stripe', { method: 'POST', body: {} })).status, 404);
  assert.strictEqual((await (await t.api('/api/health')).json()).cards, false);
});

test('signature Stripe : schéma v1 uniquement, comparaison exacte, tolérance 5 minutes ; encodage de formulaire imbriqué', () => {
  const body = '{"a":1}', now = 1_700_000_000_000, t = now / 1000;
  const good = `t=${t},v1=${crypto.createHmac('sha256', 's').update(`${t}.${body}`).digest('hex')}`;
  assert.ok(verifySignature(body, good, 's', now));
  assert.ok(!verifySignature(body + ' ', good, 's', now), 'corps modifié');
  assert.ok(!verifySignature(body, good.replace('v1=', 'v0='), 's', now), 'v0 ignoré');
  assert.ok(!verifySignature(body, good, 's', now + 301_000), 'trop ancien');
  assert.ok(!verifySignature(body, good, '', now) && !verifySignature(body, '', 's', now));
  assert.strictEqual(form({ a: { b: ['x', { c: 1 }] }, d: undefined, e: true }).join('&'), 'a%5Bb%5D%5B0%5D=x&a%5Bb%5D%5B1%5D%5Bc%5D=1&e=true');
});

test('configuration : clé Stripe invalide ou sans secret de webhook -> démarrage refusé ; clé de test avec achats réels en production -> refusé', () => {
  const base = { NAMESILO_API_KEY: 'k', JWT_SECRET: 'j'.repeat(40), AUTH_MODE: 'jwt', PAYMENTS_PROVIDER: 'paym', PAYM_CLIENT_ID: 'a', PAYM_CLIENT_SECRET: 'b' };
  assert.ok(assertSafe(loadConfig({ ...base, STRIPE_SECRET_KEY: 'pas-une-cle', STRIPE_WEBHOOK_SECRET: 'w' })).some((e) => /invalide/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_x' })).some((e) => /WEBHOOK/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'w', NODE_ENV: 'production', NAMESILO_MODE: 'live', MAILER: 'brevo', BREVO_API_KEY: 'b' })).some((e) => /TEST/.test(e)));
  assert.deepStrictEqual(assertSafe(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'w' })), []);
});

test('montant payé inférieur à la commande -> « needs_attention », rien n’est exécuté, alerte', async () => {
  const alerts = [];
  const t = await withStripe({ deps: { alert: async (...a) => alerts.push(a) } });
  const r = await (await checkout(t, {})).json();
  const sid = (await t.db.get('SELECT charge_id FROM orders')).charge_id;
  Object.assign(t.stState.sessions[sid], { payment_status: 'paid', amount_total: 100 });
  await webhook(t, completed(r.reference));
  assert.strictEqual((await t.db.get('SELECT status FROM orders')).status, 'needs_attention');
  assert.ok(!t.ns.calls.some((x) => x.op === 'registerDomain'));
  assert.ok(alerts.length >= 1);
});

async function domainWithCard(t) {
  const r = await (await checkout(t, {})).json();
  await payAndComplete(t, r); await status(t, r.orderId);
  return await t.db.get('SELECT * FROM domains');
}
const setExpiry = async (t, days) => (await t.db.run('UPDATE domains SET expires_at = ?', new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)));
const renewCalls = (t) => t.ns.calls.filter((x) => x.op === 'renewDomain').length;

test('domaine : renouvelé automatiquement 7 jours avant l’expiration sur la carte enregistrée, une seule fois, sans rappel ; pas avant', async () => {
  const t = await withStripe();
  const d = await domainWithCard(t);
  await setExpiry(t, 20); t.mailer.sent.length = 0;
  await t.app.app.jobs.run();
  assert.strictEqual(renewCalls(t), 0, 'trop tôt : seulement le rappel');
  await setExpiry(t, 6); t.mailer.sent.length = 0;
  await t.app.app.jobs.run();
  assert.strictEqual(renewCalls(t), 1);
  const after = await t.db.get('SELECT * FROM domains WHERE id = ?', d.id);
  assert.ok(after.expires_at > new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10), 'prolongé d’un an');
  assert.ok(!t.mailer.sent.some((m) => /expire/.test(m.subject)), 'aucun rappel d’expiration : déjà renouvelé');
  await t.app.app.jobs.run(); await t.app.app.jobs.run();
  assert.strictEqual(renewCalls(t), 1, 'jamais deux renouvellements');
  const pi = t.stripe.calls.filter((x) => x.path === '/v1/payment_intents').pop();
  assert.strictEqual(pi.f.off_session, 'true');
  assert.ok(await t.db.get("SELECT 1 FROM invoices WHERE label LIKE 'Renouvellement neuf.com%'"));
});

test('domaine : carte refusée -> 3 tentatives (7 j, 3 j, 1 j) puis plus rien ; rappels par e-mail conservés', async () => {
  const t = await withStripe();
  await domainWithCard(t);
  t.stState.decline = true;
  const tries = () => t.stripe.calls.filter((x) => x.path === '/v1/payment_intents').length;
  const base = tries();
  for (const days of [6, 6, 2, 0, 0, 0]) { await setExpiry(t, days); await t.app.app.jobs.run(); }
  assert.strictEqual(tries(), base + 3);
  assert.strictEqual(renewCalls(t), 0);
  assert.ok(t.mailer.sent.some((m) => /expire/.test(m.subject)), 'le client est prévenu par e-mail');
});

test('domaine : renouvellement automatique désactivé par le client, domaine sans carte, domaine dry-run -> aucun prélèvement', async () => {
  const t = await withStripe();
  await domainWithCard(t);
  await setExpiry(t, 2);
  await t.db.run('UPDATE domains SET auto_renew = 0'); await t.app.app.jobs.run();
  assert.strictEqual(renewCalls(t), 0, 'désactivé');
  await t.db.run('UPDATE domains SET auto_renew = 1, dry_run = 1'); await t.app.app.jobs.run();
  assert.strictEqual(renewCalls(t), 0, 'dry-run');
  await t.db.run('UPDATE domains SET dry_run = 0'); await t.db.run("DELETE FROM payment_methods"); await t.app.app.jobs.run();
  assert.strictEqual(renewCalls(t), 0, 'pas de carte');
});

test('domaine : un paiement manuel déjà en cours bloque le prélèvement automatique (pas de double paiement)', async () => {
  const t = await withStripe();
  await domainWithCard(t);
  await setExpiry(t, 2);
  assert.strictEqual((await t.user('/api/checkout', { method: 'POST', body: { kind: 'renewal', domain: 'neuf.com', years: 1, method: 'moncash' } })).status, 200);
  const base = t.stripe.calls.filter((x) => x.path === '/v1/payment_intents').length;
  await t.app.app.jobs.run();
  assert.strictEqual(t.stripe.calls.filter((x) => x.path === '/v1/payment_intents').length, base);
});

test('tous les moyens de paiement : un moyen sans carte (PayPal, virement…) exécute la commande sans enregistrer de carte, sans erreur', async () => {
  const t = await withStripe();
  t.stState.noCard = true;
  const r = await (await checkout(t, {})).json();
  payAndComplete(t, r);
  assert.strictEqual((await webhook(t, completed(r.reference))).status, 200);
  assert.strictEqual((await status(t, r.orderId)).status, 'succeeded');
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM payment_methods WHERE type = 'card'")).n, 0, 'rien à enregistrer : le renouvellement se fera par rappel e-mail');
});

test('moyen à confirmation différée : « completed » encore impayé -> reste en attente ; « async_payment_succeeded » (même après l’expiration locale) -> exécuté une seule fois', async () => {
  const t = await withStripe();
  const r = await (await checkout(t, {})).json();
  const sid = (await t.db.get('SELECT charge_id FROM orders')).charge_id;
  assert.strictEqual((await webhook(t, completed(r.reference))).status, 200);            // session terminée mais pas encore payée (virement en cours)
  assert.strictEqual((await t.db.get('SELECT status FROM orders')).status, 'awaiting_payment');
  assert.ok(!t.ns.calls.some((x) => x.op === 'registerDomain'));
  await t.db.run("UPDATE orders SET created_at = ?, status = 'expired'", new Date(Date.now() - 3 * 3600 * 1000).toISOString());   // 3 jours plus tard côté client : expirée localement
  t.stState.sessions[sid].payment_status = 'paid';
  const ev = { id: 'evt_2', type: 'checkout.session.async_payment_succeeded', data: { object: { client_reference_id: r.reference } } };
  assert.strictEqual((await webhook(t, ev)).status, 200);
  assert.strictEqual((await webhook(t, ev)).status, 200, 'rejoué : idempotent');
  assert.strictEqual((await t.db.get('SELECT status FROM orders')).status, 'completed');
  assert.strictEqual(t.ns.calls.filter((x) => x.op === 'registerDomain').length, 1);
});

test('moyen différé refusé (async_payment_failed) : commande en échec avec message clair ; une commande déjà exécutée n’est jamais touchée', async () => {
  const t = await withStripe();
  const r = await (await checkout(t, {})).json();
  const fail = (ref) => webhook(t, { id: 'evt_3', type: 'checkout.session.async_payment_failed', data: { object: { client_reference_id: ref } } });
  assert.strictEqual((await fail(r.reference)).status, 200);
  const st = await status(t, r.orderId);
  assert.strictEqual(st.status, 'failed'); assert.match(st.error, /refusé/);
  const r2 = await (await checkout(t, { domains: ['deux.com'] })).json();
  payAndComplete(t, r2); await webhook(t, completed(r2.reference));
  assert.strictEqual((await fail(r2.reference)).status, 200);
  assert.strictEqual((await t.db.get("SELECT status FROM orders WHERE reference = ?", r2.reference)).status, 'completed', 'jamais d’écrasement d’une commande exécutée');
  assert.strictEqual((await webhook(t, { id: 'e', type: 'checkout.session.async_payment_failed', data: { object: { client_reference_id: 'inconnue' } } })).status, 200);
});

/* ---------- Embedded Checkout (paiement dans une fenêtre du site) ---------- */
const withEmbedded = (over = {}) => withStripe({ ...over, env: { PAYMENTS_PROVIDER: 'paym', STRIPE_PUBLISHABLE_KEY: 'pk_test_abc123', ...(over.env || {}) } });

test('Embedded Checkout : la réponse porte client_secret + clé publique + script Stripe, aucune URL ; la session est « embedded_page » avec return_url', async () => {
  const t = await withEmbedded();
  const r = await (await checkout(t, {})).json();
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.redirectUrl, undefined, 'pas de page externe');
  assert.deepStrictEqual(r.embedded, { clientSecret: 'cs_0_secret_abc', publishableKey: 'pk_test_abc123', scriptUrl: 'https://js.stripe.com/endive/stripe.js' });
  const c = t.stripe.calls.find((x) => x.path === '/v1/checkout/sessions').f;
  assert.strictEqual(c.ui_mode, 'embedded_page'); assert.strictEqual(c.redirect_on_completion, 'if_required');
  assert.ok(c.return_url.includes('payment=success') && c.return_url.includes('order=' + r.orderId), 'retour (3-D Secure, banques) : la page sait quelle commande confirmer');
  assert.ok(!c.success_url && !c.cancel_url);
  assert.strictEqual((await t.db.get('SELECT redirect_url FROM orders')).redirect_url, '', 'rien de sensible stocké');
  assert.ok(!JSON.stringify(await t.db.all('SELECT * FROM orders')).includes('secret_abc'), 'le client_secret n’est jamais écrit en base');
  assert.ok(t.stripe.calls.every((x) => x.version === '2026-09-30.endive'), 'version d’API figée sur tous les appels');
});

test('Embedded Checkout : après le paiement dans la fenêtre, le webhook (ou le sondage) exécute la commande une seule fois et la carte est enregistrée', async () => {
  const t = await withEmbedded();
  const r = await (await checkout(t, {})).json();
  payAndComplete(t, r);
  assert.strictEqual((await webhook(t, completed(r.reference))).status, 200);
  assert.strictEqual((await status(t, r.orderId)).status, 'succeeded');
  assert.strictEqual(t.ns.calls.filter((x) => x.op === 'registerDomain').length, 1);
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM payment_methods WHERE type = 'card'")).n, 1);
});

test('reprise du paiement intégré : GET /api/orders/:id/payment rend le client_secret au propriétaire seulement, tant que la session est ouverte', async () => {
  const t = await withEmbedded();
  const r = await (await checkout(t, {})).json();
  const again = await t.user(`/api/orders/${r.orderId}/payment`);
  assert.strictEqual(again.status, 200);
  assert.deepStrictEqual((await again.json()).embedded.clientSecret, 'cs_0_secret_abc');
  assert.strictEqual((await t.as('autre@example.com')(`/api/orders/${r.orderId}/payment`)).status, 404, 'isolation entre comptes');
  assert.strictEqual((await t.api(`/api/orders/${r.orderId}/payment`)).status, 401);
  t.stState.sessions['cs_0'].status = 'expired';
  assert.strictEqual((await t.user(`/api/orders/${r.orderId}/payment`)).status, 409, 'session expirée : recommencer');
  const r2 = await (await checkout(t, { domains: ['deux.com'] })).json();
  payAndComplete(t, r2); await webhook(t, completed(r2.reference));
  assert.strictEqual((await t.user(`/api/orders/${r2.orderId}/payment`)).status, 409, 'commande déjà payée : plus de paiement à reprendre');
});

test('sans clé publique : repli sur la page Stripe hébergée (nouvel onglet) ; carte enregistrée qui exige 3-D Secure : bascule vers la fenêtre intégrée', async () => {
  const hosted = await withStripe();
  const h = await (await checkout(hosted, {})).json();
  assert.match(h.redirectUrl, /checkout\.stripe\.test/); assert.strictEqual(h.embedded, undefined);
  const t = await withEmbedded();
  const first = await (await checkout(t, {})).json(); payAndComplete(t, first); await status(t, first.orderId);
  const methodId = (await (await t.user('/api/payment-methods')).json()).methods[0].id;
  t.stState.authRequired = true;
  const third = await (await checkout(t, { domains: ['trois.com'], methodId })).json();
  assert.strictEqual(third.status, 'pending'); assert.ok(third.embedded && third.embedded.clientSecret, '3-D Secure : le client termine dans la fenêtre intégrée');
});

test('configuration : clé publique invalide, secrète collée par erreur, mode différent de la clé secrète, URL de script étrangère -> refusés', () => {
  const base = { NAMESILO_API_KEY: 'k', JWT_SECRET: 'j'.repeat(40), PAYMENTS_PROVIDER: 'paym', PAYM_CLIENT_ID: 'a', PAYM_CLIENT_SECRET: 'b' };
  const errs = (env) => assertSafe(loadConfig({ ...base, ...env }));
  assert.ok(errs({ STRIPE_PUBLISHABLE_KEY: 'sk_live_secret' }).some((e) => /JAMAIS la clé secrète/.test(e)), 'une clé secrète n’est jamais envoyée au navigateur');
  assert.ok(errs({ STRIPE_PUBLISHABLE_KEY: 'n-importe-quoi' }).some((e) => /invalide/.test(e)));
  assert.ok(errs({ STRIPE_PUBLISHABLE_KEY: 'pk_live_x', STRIPE_SECRET_KEY: 'sk_test_y', STRIPE_WEBHOOK_SECRET: 'w' }).some((e) => /même mode/.test(e)));
  assert.ok(errs({ STRIPE_JS_URL: 'https://evil.example/stripe.js' }).some((e) => /STRIPE_JS_URL/.test(e)));
  assert.deepStrictEqual(errs({ STRIPE_PUBLISHABLE_KEY: 'pk_live_x', STRIPE_SECRET_KEY: 'sk_live_y', STRIPE_WEBHOOK_SECRET: 'w' }), []);
  assert.strictEqual(loadConfig({ ...base, STRIPE_PUBLISHABLE_KEY: 'pk_live_x', STRIPE_UI_MODE: 'hosted' }).payments.stripe.uiMode, 'hosted', 'repli volontaire sur la page hébergée');
});
