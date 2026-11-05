/**
 * Stripe : paiements par carte bancaire (Checkout hébergé) et prélèvements automatiques des abonnements.
 *
 * Flux (https://docs.stripe.com/payments) :
 *  1. Premier paiement : POST /v1/checkout/sessions (mode=payment, customer, payment_method_options[card][setup_future_usage]=off_session) -> l'URL hébergée par Stripe.
 *     Le client choisit son moyen de paiement chez Stripe (carte, Apple Pay, Google Pay, Link, et tous ceux activés au Dashboard) : aucune donnée de paiement ne touche ce serveur (PCI SAQ A).
 *     Seule une CARTE est enregistrée pour les prélèvements suivants. Les moyens à confirmation différée (virements, débits) sont confirmés plus tard par checkout.session.async_payment_succeeded / _failed.
 *  2. Confirmation : webhook signé (checkout.session.completed) ET vérification serveur (GET /v1/checkout/sessions/:id) ; l'état n'est jamais lu du navigateur.
 *  3. Renouvellement : POST /v1/payment_intents (customer, payment_method, off_session=true, confirm=true) sans action du client.
 *     Si la banque exige une authentification (authentication_required) ou refuse, le prélèvement échoue proprement (le client est prévenu par e-mail).
 *  4. Remboursement : POST /v1/refunds (payment_intent).
 * Montants en cents USD, calculés côté serveur uniquement. Clés d'idempotence = référence de commande (aucun double débit en cas de nouvelle tentative).
 */
const crypto = require('crypto');
const { HttpError } = require('./errors');
const { cardFee } = require('./fees');

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
      headers: { Authorization: `Bearer ${secretKey}`, ...(cfg.payments.stripe.apiVersion ? { 'Stripe-Version': cfg.payments.stripe.apiVersion } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idem ? { 'Idempotency-Key': idem } : {}) },
      body: method === 'GET' ? undefined : q,
      signal: AbortSignal.timeout(25000),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { throw new StripeError(502, { message: 'Réponse Stripe illisible' }); }
    if (!res.ok) { log('warn', 'stripe_error', { path, status: res.status, code: data.error && data.error.code, type: data.error && data.error.type, param: data.error && data.error.param, message: data.error && String(data.error.message || '').slice(0, 300) }); throw new StripeError(res.status, data.error || {}); }
    return data;
  }

  async function customerFor(userId) {
    const u = await db.get('SELECT id, email, name, stripe_customer_id FROM users WHERE id = ?', userId);
    if (!u) throw new HttpError(404, 'Compte introuvable.', 'not_found');
    if (u.stripe_customer_id) return u.stripe_customer_id;
    const c = await api('POST', '/v1/customers', { email: u.email, name: u.name || undefined, metadata: { user_id: u.id } }, { idem: 'cust-' + u.id });
    await db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id = ?', c.id, u.id, '');
    return (await db.get('SELECT stripe_customer_id FROM users WHERE id = ?', u.id)).stripe_customer_id;
  }

  const cents = (usd) => Math.round(usd * 100);

  /** Enregistre (ou retrouve) la carte utilisée ; la première carte devient la carte par défaut. */
  async function saveCard(userId, pm) {
    if (!pm || !pm.id || !pm.card) return null;
    const known = await db.get('SELECT id FROM payment_methods WHERE user_id = ? AND stripe_pm = ?', userId, pm.id);
    if (known) return known.id;
    const exp = `${String(pm.card.exp_month).padStart(2, '0')}/${String(pm.card.exp_year).slice(-2)}`;
    const first = !(await db.get('SELECT 1 FROM payment_methods WHERE user_id = ?', userId));
    const mid = 'pm_' + crypto.randomBytes(8).toString('hex');
    await db.run('INSERT INTO payment_methods (id, user_id, type, phone, brand, last4, exp, is_default, created_at, stripe_pm) VALUES (?,?,?,?,?,?,?,?,?,?)', mid, userId, 'card', '', pm.card.brand || '', pm.card.last4 || '', exp, first ? 1 : 0, new Date().toISOString(), pm.id);
    return mid;
  }

  const embedded = () => cfg.payments.stripe.uiMode === 'embedded';
  const embeddedInfo = (clientSecret) => ({ clientSecret, publishableKey: cfg.payments.stripe.publishableKey, scriptUrl: cfg.payments.stripe.jsUrl });

  /**
   * Session Checkout. Mode « embedded » (STRIPE_PUBLISHABLE_KEY défini) : le formulaire de paiement Stripe s'affiche DANS une fenêtre du site (iframe Stripe, ui_mode=embedded_page) ;
   * retourne client_secret (pas d'URL). Redirection (3-D Secure, banques) et retour : return_url. Mode « hosted » : page Stripe dans un nouvel onglet (success_url / cancel_url).
   */
  async function createCheckout({ amount, reference, userId, label, orderId }) {
    const customer = await customerFor(userId);
    const back = (state) => `${cfg.appUrl}/espace/facturation?payment=${state}&order=${encodeURIComponent(orderId || '')}`;
    const s = await api('POST', '/v1/checkout/sessions', {
      // PAS de payment_method_types : Checkout propose TOUS les moyens activés dans le Dashboard Stripe (Paramètres > Moyens de paiement) et éligibles pour la devise,
      // le montant et le pays du client. Seule la CARTE est enregistrée pour les prélèvements automatiques (les autres moyens ne servent qu'à ce paiement).
      mode: 'payment', customer, client_reference_id: reference,
      // Les Managed Payments de Stripe (marchand officiel, codes fiscaux produit obligatoires) ne conviennent pas aux noms de domaine ni aux frais de traitement : désactivés pour ces sessions.
      managed_payments: { enabled: false },
      ...(cfg.payments.stripe.paymentMethodConfig ? { payment_method_configuration: cfg.payments.stripe.paymentMethodConfig } : {}),
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents(amount), product_data: { name: label || 'Freda Workspace' } } }, { quantity: 1, price_data: { currency: 'usd', unit_amount: cents(cardFee(amount)), product_data: { name: 'Frais de traitement du paiement (3,5 % + 0,40 $)' } } }],
      payment_method_options: { card: { setup_future_usage: 'off_session' } },
      payment_intent_data: { metadata: { reference } },
      metadata: { reference },
      ...(embedded()
        ? { ui_mode: 'embedded_page', return_url: back('success'), redirect_on_completion: 'if_required' }
        : { success_url: back('success'), cancel_url: back('cancelled') }),
      expires_at: Math.floor(Date.now() / 1000) + 2 * 3600,
    }, { idem: 'cs-' + reference });
    if (embedded()) return { status: 'pending', providerRef: s.id, embedded: embeddedInfo(s.client_secret), amountCents: cents(amount) + cents(cardFee(amount)) };
    return { status: 'pending', providerRef: s.id, redirectUrl: s.url, amountCents: cents(amount) + cents(cardFee(amount)) };
  }

  /** Reprise d'un paiement intégré fermé par erreur : le client_secret d'une session encore ouverte est relu chez Stripe (jamais stocké chez nous). */
  async function resumeEmbedded(order) {
    if (!embedded() || !order.charge_id || !order.charge_id.startsWith('cs_')) return null;
    const s = await api('GET', `/v1/checkout/sessions/${encodeURIComponent(order.charge_id)}`);
    return s.status === 'open' && s.client_secret ? embeddedInfo(s.client_secret) : null;
  }

  /** Prélèvement sans action du client sur une carte enregistrée. `allowRedirect` : en cas d'authentification exigée, bascule vers Checkout (achat initié par le client). */
  async function chargeSaved({ amount, reference, userId, methodId, label, allowRedirect, orderId }) {
    const m = await db.get("SELECT * FROM payment_methods WHERE id = ? AND user_id = ? AND type = 'card' AND stripe_pm <> ''", methodId, userId);
    if (!m) throw new HttpError(404, 'Carte enregistrée introuvable.', 'not_found');
    const customer = await customerFor(userId);
    const total = cents(amount) + cents(cardFee(amount));
    const attempt = () => api('POST', '/v1/payment_intents', { amount: total, currency: 'usd', customer, payment_method: m.stripe_pm, off_session: true, confirm: true, description: label, metadata: { reference } }, { idem: 'pi-' + reference });
    try {
      let pi;
      // Timeout / erreur réseau / 5xx : la carte a peut-être été débitée. On rejoue UNE fois avec la même clé d'idempotence (jamais de double débit) ;
      // si le doute demeure, la commande reste « en attente » et verify() retrouve le paiement chez Stripe par sa référence.
      try { pi = await attempt(); }
      catch (e0) { if (e0 instanceof StripeError && e0.status < 500) throw e0; log('warn', 'stripe_charge_uncertain_retry', { reference }); try { pi = await attempt(); } catch (e1) { if (e1 instanceof StripeError && e1.status < 500) throw e1; log('error', 'stripe_charge_uncertain', { reference, message: e1.message }); return { status: 'pending', providerRef: '', amountCents: total }; } }
      if (pi.status === 'succeeded') return { status: 'paid', providerRef: pi.id, amountCents: pi.amount_received || pi.amount };
      throw new StripeError(402, { code: 'requires_action', message: 'Authentification de la banque requise.' });
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      const needsAuth = e.code === 'authentication_required' || e.code === 'requires_action' || e.paymentIntent && e.paymentIntent.status === 'requires_action';
      if (needsAuth && allowRedirect) return await createCheckout({ amount, reference, userId, label, orderId });
      if (e.status >= 500) throw e;
      const err = new Error(needsAuth ? 'Votre banque demande une authentification : payez depuis votre espace client.' : 'Carte refusée par la banque. Essayez une autre carte ou MonCash.');
      err.name = 'CardDeclined'; err.code = e.code; throw err;
    }
  }

  async function sessionFor(order) {
    return await api('GET', `/v1/checkout/sessions/${encodeURIComponent(order.charge_id)}`, { expand: ['payment_intent.payment_method'] });
  }

  /** État réel du paiement, lu chez Stripe. Enregistre la carte au passage. */
  async function verify({ order }) {
    if (!order.charge_id) {
      // débit incertain (timeout) : on cherche le paiement chez Stripe par la référence de commande
      try {
        const r = await api('GET', '/v1/payment_intents/search', { query: `metadata['reference']:'${String(order.reference).replace(/[^\w-]/g, '')}'`, limit: 1 });
        const pi = r.data && r.data[0];
        if (pi && pi.status === 'succeeded') return { status: 'paid', amountCents: pi.amount_received || pi.amount, paymentIntent: pi.id };
        if (pi && ['canceled', 'requires_payment_method'].includes(pi.status)) return { status: 'failed' };
      } catch (e) { log('warn', 'stripe_lookup_failed', { message: e.message }); }
      return { status: 'pending' };
    }
    if (order.charge_id.startsWith('pi_')) {
      const pi = await api('GET', `/v1/payment_intents/${order.charge_id}`);
      return { status: pi.status === 'succeeded' ? 'paid' : 'pending', amountCents: pi.amount_received || 0 };
    }
    const s = await sessionFor(order);
    if (s.payment_status !== 'paid') return { status: s.status === 'expired' ? 'failed' : 'pending' };
    const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
    if (pi && pi.payment_method && typeof pi.payment_method === 'object') { try { await saveCard(order.user_id, pi.payment_method); } catch (e) { log('warn', 'card_save_failed', { message: e.message }); } }
    return { status: 'paid', amountCents: s.amount_total || 0, paymentIntent: pi ? pi.id : (typeof s.payment_intent === 'string' ? s.payment_intent : '') };
  }

  async function refund({ order, amount }) {
    let pi = order.charge_id;
    if (pi.startsWith('cs_')) { const s = await sessionFor(order); pi = typeof s.payment_intent === 'object' && s.payment_intent ? s.payment_intent.id : s.payment_intent; }
    if (!pi) throw new Error('Paiement Stripe introuvable pour le remboursement.');
    const c = amount ? cents(amount) : undefined;
    return await api('POST', '/v1/refunds', { payment_intent: pi, amount: c, metadata: { reference: order.reference } }, { idem: `refund-${order.reference}-${c || 'full'}` });
  }

  /** Détache la carte chez Stripe quand le client la supprime (elle ne pourra plus être débitée). */
  async function detach(stripePm) { if (enabled && stripePm) await api('POST', `/v1/payment_methods/${encodeURIComponent(stripePm)}/detach`, {}); }

  return { enabled, createCheckout, resumeEmbedded, chargeSaved, verify, refund, detach, saveCard };
}

module.exports = { createStripe, StripeError, verifySignature, form };
