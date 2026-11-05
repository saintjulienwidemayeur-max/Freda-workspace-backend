/**
 * Fournisseurs de paiement.
 *
 *  - « paym » : Pay'm (plopplop.solutionip.app) — MonCash / NatCash par redirection. Flux (comme dans backend-fredapay/src/services/paym.service.ts) :
 *      POST api/paiement-marchand { client_id, refference_id, montant (HTG, ≥ 20), payment_method } -> { status, url, transaction_id }
 *      POST api/paiement-verify   { client_id, refference_id } -> { trans_status: 'ok' | 'no', montant, id_transaction, ... }
 *    Le client paie sur l'URL renvoyée : le paiement est donc ASYNCHRONE (commande « awaiting_payment », confirmée par verify()).
 *    Pay'm ne renvoie pas le numéro du payeur : un remboursement automatique est impossible → alerte + traitement manuel.
 *    ⚠ Écrit d'après le code de backend-fredapay (documentation https://plopplop.solutionip.app/paiement-doc non accessible).
 *  - « issuing » : Freda Pay Issuing (api.fredapay.com, https://issuing.fredapay.com/docs) — MonCash / NatCash par redirection, en HTG.
 *      POST /v1/payments { amount (HTG ≥ 20), method, reference, currency: 'HTG' } -> 201 { id, status: pending | succeeded | failed, checkout_url }
 *      GET  /v1/payments/:id -> { status, amount, currency, fee, net_amount, customer_phone } (interroge MonCash / NatCash à chaque appel)
 *      Webhook signé (X-Freda-Signature: sha256=HMAC du corps brut, secret whsec_…) : payment.succeeded / payment.failed -> POST /api/webhooks/issuing.
 *    Une référence déjà utilisée renvoie le paiement existant (pas de double paiement). Clé sk_test_… = Sandbox, sk_live_… = argent réel.
 *    Remboursement : non automatique (alerte + traitement manuel).
 *  - « demo » : approuve tout immédiatement (développement/tests). Interdit avec NAMESILO_MODE=live.
 *
 * Cartes bancaires : aucun processeur d'acquisition n'est branché (Maplerad sert à émettre des cartes, pas à encaisser).
 */
const { HttpError } = require('./errors');
const { createStripe } = require('./stripe');
const { mobileFee } = require('./fees');

class PaymentError extends Error {
  constructor(message, status = 402) { super(message); this.name = 'PaymentError'; this.status = status; }
}
class RefundNotSupported extends Error { constructor() { super('Remboursement automatique indisponible : à traiter manuellement.'); this.name = 'RefundNotSupported'; } }

function createDemo() {
  return {
    name: 'demo',
    async create({ amount, reference }) {
      if (!(amount > 0)) throw new PaymentError('Montant invalide.');
      return { status: 'paid', providerRef: 'demo_' + reference };
    },
    async verify() { return { status: 'paid' }; },
    async refund({ reference }) { return { id: 'refund_' + reference }; },
  };
}

function createPaym(cfg, log) {
  const { clientId, clientSecret, baseUrl } = cfg.payments.paym;
  async function post(endpoint, body, retry = 0) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (res.status === 429 && retry < 1) { await new Promise((r) => setTimeout(r, 2000)); return await post(endpoint, body, retry + 1); }
    let data;
    try { data = await res.json(); } catch (e) { throw new PaymentError('Le service de paiement est indisponible. Réessayez.', 502); }
    if (!res.ok) { log('error', 'paym_error', { endpoint, status: res.status }); throw new PaymentError(data.message || data.error || 'Le service de paiement a refusé la demande.', res.status >= 500 ? 502 : 402); }
    return data;
  }
  return {
    name: 'paym',
    htg: (usd) => Math.ceil(usd * cfg.pricing.htgRate),
    async create({ amount, method, reference }) {
      if (method === 'card') throw new HttpError(501, 'Les cartes bancaires ne sont pas encore disponibles. Utilisez MonCash ou NatCash.', 'card_not_available');
      if (!['moncash', 'natcash', 'all'].includes(method)) throw new HttpError(400, 'Moyen de paiement inconnu.', 'invalid_method');
      const montant = Math.ceil((amount + mobileFee(amount)) * cfg.pricing.htgRate);
      if (montant < 20) throw new PaymentError('Montant minimum : 20 HTG.', 400);
      const data = await post('api/paiement-marchand', { client_id: clientId, refference_id: reference, montant, payment_method: method });   // « refference_id » : orthographe de l'API
      if (!data.status || !data.url) throw new PaymentError(data.message || 'URL de paiement manquante. Réessayez.', 502);
      return { status: 'pending', providerRef: String(data.transaction_id || ''), redirectUrl: data.url, amountHtg: montant };
    },
    async verify({ reference }) {
      const data = await post('api/paiement-verify', { client_id: clientId, refference_id: reference });
      return { status: data.trans_status === 'ok' ? 'paid' : 'pending', amountHtg: Number(data.montant || 0), transactionId: data.id_transaction || '' };
    },
    async refund() { throw new RefundNotSupported(); },
  };
}

function createIssuing(cfg, log) {
  const { secretKey, baseUrl } = cfg.payments.issuing;
  const url = (path) => `${baseUrl.replace(/\/$/, '')}${path}`;
  async function call(method, path, body, retry = 0) {
    let res;
    try { res = await fetch(url(path), { method, headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw new PaymentError('Le service de paiement est indisponible. Réessayez.', 502); }
    if ((res.status === 429 || res.status >= 502) && retry < 1) { await new Promise((r) => setTimeout(r, 2000)); return await call(method, path, body, retry + 1); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* corps vide ou invalide */ }
    if (!res.ok) {
      const err = (data && data.error) || {};
      log('error', 'issuing_error', { path: path.replace(/pay_[\w]+/, 'pay_…'), status: res.status, code: err.code || '' });
      if (res.status === 401 || res.status === 403) throw new PaymentError('Le service de paiement n’est pas correctement configuré. Notre équipe a été prévenue.', 502);
      throw new PaymentError((typeof err === 'string' ? err : err.message) || data.message || 'Le service de paiement a refusé la demande.', res.status >= 500 ? 502 : 402);
    }
    return data;
  }
  const htg = (usd) => Math.ceil(usd * cfg.pricing.htgRate);
  return {
    name: 'issuing',
    htg,
    async create({ amount, method, reference }) {
      if (method === 'card') throw new HttpError(501, 'Les cartes bancaires ne sont pas encore disponibles. Utilisez MonCash ou NatCash.', 'card_not_available');
      if (!['moncash', 'natcash', 'all'].includes(method)) throw new HttpError(400, 'Moyen de paiement inconnu.', 'invalid_method');
      const montant = htg(amount + mobileFee(amount));       // frais de traitement MonCash / NatCash : 6 %
      if (montant < 20) throw new PaymentError('Montant minimum : 20 HTG.', 400);
      const data = await call('POST', '/v1/payments', { amount: montant, currency: 'HTG', method, reference });
      if (!data.id || !data.checkout_url) throw new PaymentError('URL de paiement manquante. Réessayez.', 502);
      if (data.status === 'succeeded') return { status: 'paid', providerRef: String(data.id), amountHtg: montant };
      return { status: 'pending', providerRef: String(data.id), redirectUrl: data.checkout_url, amountHtg: montant };
    },
    async verify({ order }) {
      const id = order && order.charge_id;
      if (!id) return { status: 'pending', amountHtg: 0 };               // paiement jamais créé chez le fournisseur : rien à vérifier
      const data = await call('GET', `/v1/payments/${encodeURIComponent(id)}`);
      if (data.status === 'succeeded') return { status: 'paid', amountHtg: data.currency === 'HTG' ? Number(data.amount) || 0 : 0, transactionId: String(data.id), phone: data.customer_phone || '' };
      if (data.status === 'failed') return { status: 'failed' };
      return { status: 'pending' };
    },
    async refund() { throw new RefundNotSupported(); },
  };
}

/**
 * Routeur : la carte bancaire passe par Stripe (si STRIPE_SECRET_KEY est définie), MonCash / NatCash par Freda Pay Issuing (ou Pay'm).
 * La vérification et le remboursement suivent le moyen de paiement de la commande.
 */
function createPayments(cfg, log = () => {}, { db } = {}) {
  let base;
  if (cfg.payments.provider === 'paym') base = createPaym(cfg, log);
  else if (cfg.payments.provider === 'issuing') base = createIssuing(cfg, log);
  else if (cfg.payments.provider === 'demo') base = createDemo();
  else throw new Error('PAYMENTS_PROVIDER inconnu : ' + cfg.payments.provider);
  if (!cfg.payments.stripe.secretKey || !db) return base;
  const stripe = createStripe({ cfg, db, log });
  const isCard = (order) => order && order.payment_method === 'card';
  return {
    ...base,
    stripe,
    cards: true,
    async create(a) {
      if (a.method !== 'card') return base.create(a);
      if (!(a.amount >= 0.5)) throw new PaymentError('Montant minimum par carte : 0,50 $.', 400);
      try {
        return a.methodId ? await stripe.chargeSaved({ ...a, allowRedirect: !a.system }) : await stripe.createCheckout(a);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e.name === 'CardDeclined') throw new PaymentError(e.message, 402);
        log('error', 'stripe_create_failed', { code: e.code, status: e.status });
        throw new PaymentError('Le paiement par carte est momentanément indisponible. Réessayez ou utilisez MonCash.', 502);
      }
    },
    verify: async (a) => (isCard(a.order) ? (await stripe.verify(a)) : base.verify(a)),
    refund: async (a) => (isCard(a.order) ? (await stripe.refund(a)) : base.refund(a)),
  };
}

module.exports = { createPayments, PaymentError, RefundNotSupported };
