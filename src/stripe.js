/**
 * Stripe : paiements par carte bancaire (Checkout hébergé) et prélèvements automatiques des abonnements.
 *
 * Flux (https://docs.stripe.com/payments) :
 *  1. Premier paiement : POST /v1/checkout/sessions (mode=payment, customer, payment_intent_data[setup_future_usage]=off_session) -> l'URL hébergée par Stripe.
 *     Le client saisit sa carte chez Stripe : aucune donnée de carte ne touche ce serveur (PCI SAQ A). La carte est enregistrée pour les prélèvements suivants.
 *  2. Confirmation : webhook signé (checkout.session.completed) ET vérification serveur (GET /v1/checkout/sessions/:id) ; l'état n'est jamais lu du navigateur.
 *  3. Renouvellement : POST /v1/payment_intents (customer, payment_method, off_session=true, confirm=true) sans action du client.
 *     Si la banque exige une authentification (authentication_required) ou refuse, le prélèvement échoue proprement (le client est prévenu par e-mail).
 *  4. Remboursement : POST /v1/refunds (payment_intent).
 * Montants en cents USD, calculés côté serveur uniquement. Clés d'idempotence = référence de commande (aucun double débit en cas de nouvelle tentative).
 */
const crypto = require('crypto');
const { HttpError } = require('./errors');

class StripeError extends Error {
  constructor(status, err = {}) { super(err.message || 'Erreur Stripe'); this.name = 'StripeError'; this.status = status; this.code = err.code || ''; this.declineCode = err.decline_code || ''; this.type = err.type || ''; this.paymentIntent = err.payment_intent || null; }
}

/** Encodage application/x-www-form-urlencoded imbriqué de Stripe : a[b][0]=c */
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

/** Vérifie l'en-tête Stripe-Signature (t=…,v1=…) : HMAC-SHA256 de « t.corps » avec le secret whsec_, tolérance 5 min, seul le schéma v1 compte. */
function verifySignature(rawBody, header, secret, now = Date.now(), toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map((s) => s.trim().split('='));
  const t = (parts.find((p) => p[0] === 't') || [])[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || !sigs.length || !/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

function createStripe({ cfg, db, log }) {
  const { secretKey, baseUrl } = cfg.payments.stripe;
  const enabled = !!secretKey;

  async function api(method, path, params = {}, { idem } = {}) {
    const q = form(params).join('&');
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}${method === 'GET' && q ? '?' + q : ''}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idem ? { 'Idempotency-Key': idem } : {}) },
      body: method === 'GET' ? undefined : q,
      signal: AbortSignal.timeout(25000),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { throw new StripeError(502, { message: 'Réponse Stripe illisible' }); }
    if (!res.ok) { log('warn', 'stripe_error', { path, status: res.status, code: data.error && data.error.code, type: data.error && data.error.type }); throw new StripeError(res.status, data.error || {}); }
    return data;
  }

  async function customerFor(userId) {
    const u = db.get('SELECT id, email, name, stripe_customer_id FROM users WHERE id = ?', userId);
    if (!u) throw new HttpError(404, 'Compte introuvable.', 'not_found');
    if (u.stripe_customer_id) return u.stripe_customer_id;
    const c = await api('POST', '/v1/customers', { email: u.email, name: u.name || undefined, metadata: { user_id: u.id } }, { idem: 'cust-' + u.id });
    db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id = ?', c.id, u.id, '');
    return db.get('SELECT stripe_customer_id FROM users WHERE id = ?', u.id).stripe_customer_id;
  }

  const cents = (usd) => Math.round(usd * 100);

  /** Enregistre (ou retrouve) la carte utilisée ; la première carte devient la carte par défaut. */
  function saveCard(userId, pm) {
    if (!pm || !pm.id || !pm.card) return null;
    const known = db.get('SELECT id FROM payment_methods WHERE user_id = ? AND stripe_pm = ?', userId, pm.id);
    if (known) return known.id;
    const exp = `${String(pm.card.exp_month).padStart(2, '0')}/${String(pm.card.exp_year).slice(-2)}`;
    const first = !db.get('SELECT 1 FROM payment_methods WHERE user_id = ?', userId);
    const mid = 'pm_' + crypto.randomBytes(8).toString('hex');
    db.run('INSERT INTO payment_methods (id, user_id, type, phone, brand, last4, exp, is_default, created_at, stripe_pm) VALUES (?,?,?,?,?,?,?,?,?,?)', mid, userId, 'card', '', pm.card.brand || '', pm.card.last4 || '', exp, first ? 1 : 0, new Date().toISOString(), pm.id);
    return mid;
  }

  async function createCheckout({ amount, reference, userId, label }) {
    const customer = await customerFor(userId);
    const s = await api('POST', '/v1/checkout/sessions', {
      mode: 'payment', customer, client_reference_id: reference, payment_method_types: ['card'],
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents(amount), product_data: { name: label || 'Freda Workspace' } } }],
      payment_intent_data: { setup_future_usage: 'off_session', metadata: { reference } },
      metadata: { reference },
      success_url: `${cfg.appUrl}/espace/facturation.html?payment=success&ref=${encodeURIComponent(reference)}`,
      cancel_url: `${cfg.appUrl}/espace/facturation.html?payment=cancelled&ref=${encodeURIComponent(reference)}`,
      expires_at: Math.floor(Date.now() / 1000) + 2 * 3600,
    }, { idem: 'cs-' + reference });
    return { status: 'pending', providerRef: s.id, redirectUrl: s.url, amountCents: cents(amount) };
  }

  /** Prélèvement sans action du client sur une carte enregistrée. `allowRedirect` : en cas d'authentification exigée, bascule vers Checkout (achat initié par le client). */
  async function chargeSaved({ amount, reference, userId, methodId, label, allowRedirect }) {
    const m = db.get("SELECT * FROM payment_methods WHERE id = ? AND user_id = ? AND type = 'card' AND stripe_pm <> ''", methodId, userId);
    if (!m) throw new HttpError(404, 'Carte enregistrée introuvable.', 'not_found');
    const customer = await customerFor(userId);
    try {
      const pi = await api('POST', '/v1/payment_intents', { amount: cents(amount), currency: 'usd', customer, payment_method: m.stripe_pm, off_session: true, confirm: true, description: label, metadata: { reference } }, { idem: 'pi-' + reference });
      if (pi.status === 'succeeded') return { status: 'paid', providerRef: pi.id, amountCents: pi.amount_received || pi.amount };
      throw new StripeError(402, { code: 'requires_action', message: 'Authentification de la banque requise.' });
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      const needsAuth = e.code === 'authentication_required' || e.code === 'requires_action' || e.paymentIntent && e.paymentIntent.status === 'requires_action';
      if (needsAuth && allowRedirect) return createCheckout({ amount, reference, userId, label });
      if (e.status >= 500) throw e;
      const err = new Error(needsAuth ? 'Votre banque demande une authentification : payez depuis votre espace client.' : 'Carte refusée par la banque. Essayez une autre carte ou MonCash.');
      err.name = 'CardDeclined'; err.code = e.code; throw err;
    }
  }

  async function sessionFor(order) {
    return api('GET', `/v1/checkout/sessions/${encodeURIComponent(order.charge_id)}`, { expand: ['payment_intent.payment_method'] });
  }

  /** État réel du paiement, lu chez Stripe. Enregistre la carte au passage. */
  async function verify({ order }) {
    if (!order.charge_id) return { status: 'pending' };
    if (order.charge_id.startsWith('pi_')) {
      const pi = await api('GET', `/v1/payment_intents/${order.charge_id}`);
      return { status: pi.status === 'succeeded' ? 'paid' : 'pending', amountCents: pi.amount_received || 0 };
    }
    const s = await sessionFor(order);
    if (s.payment_status !== 'paid') return { status: s.status === 'expired' ? 'failed' : 'pending' };
    const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
    if (pi && pi.payment_method && typeof pi.payment_method === 'object') { try { saveCard(order.user_id, pi.payment_method); } catch (e) { log('warn', 'card_save_failed', { message: e.message }); } }
    return { status: 'paid', amountCents: s.amount_total || 0, paymentIntent: pi ? pi.id : (typeof s.payment_intent === 'string' ? s.payment_intent : '') };
  }

  async function refund({ order, amount }) {
    let pi = order.charge_id;
    if (pi.startsWith('cs_')) { const s = await sessionFor(order); pi = typeof s.payment_intent === 'object' && s.payment_intent ? s.payment_intent.id : s.payment_intent; }
    if (!pi) throw new Error('Paiement Stripe introuvable pour le remboursement.');
    const c = amount ? cents(amount) : undefined;
    return api('POST', '/v1/refunds', { payment_intent: pi, amount: c, metadata: { reference: order.reference } }, { idem: `refund-${order.reference}-${c || 'full'}` });
  }

  /** Détache la carte chez Stripe quand le client la supprime (elle ne pourra plus être débitée). */
  async function detach(stripePm) { if (enabled && stripePm) await api('POST', `/v1/payment_methods/${encodeURIComponent(stripePm)}/detach`, {}); }

  return { enabled, createCheckout, chargeSaved, verify, refund, detach, saveCard };
}

module.exports = { createStripe, StripeError, verifySignature, form };
