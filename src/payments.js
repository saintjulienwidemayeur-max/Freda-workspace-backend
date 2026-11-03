/**
 * Fournisseurs de paiement.
 *
 *  - « paym » : Pay'm (plopplop.solutionip.app) — MonCash / NatCash par redirection. Flux (comme dans backend-fredapay/src/services/paym.service.ts) :
 *      POST api/paiement-marchand { client_id, refference_id, montant (HTG, ≥ 20), payment_method } -> { status, url, transaction_id }
 *      POST api/paiement-verify   { client_id, refference_id } -> { trans_status: 'ok' | 'no', montant, id_transaction, ... }
 *    Le client paie sur l'URL renvoyée : le paiement est donc ASYNCHRONE (commande « awaiting_payment », confirmée par verify()).
 *    Pay'm ne renvoie pas le numéro du payeur : un remboursement automatique est impossible → alerte + traitement manuel.
 *    ⚠ Écrit d'après le code de backend-fredapay (documentation https://plopplop.solutionip.app/paiement-doc non accessible).
 *  - « demo » : approuve tout immédiatement (développement/tests). Interdit avec NAMESILO_MODE=live.
 *
 * Cartes bancaires : aucun processeur d'acquisition n'est branché (Maplerad sert à émettre des cartes, pas à encaisser).
 */
const { HttpError } = require('./errors');
const { createStripe } = require('./stripe');

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
    if (res.status === 429 && retry < 1) { await new Promise((r) => setTimeout(r, 2000)); return post(endpoint, body, retry + 1); }
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
      const montant = Math.ceil(amount * cfg.pricing.htgRate);
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

/**
 * Routeur : la carte bancaire passe par Stripe (si STRIPE_SECRET_KEY est définie), MonCash / NatCash par Pay'm.
 * La vérification et le remboursement suivent le moyen de paiement de la commande.
 */
function createPayments(cfg, log = () => {}, { db } = {}) {
  let base;
  if (cfg.payments.provider === 'paym') base = createPaym(cfg, log);
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
    verify: (a) => (isCard(a.order) ? stripe.verify(a) : base.verify(a)),
    refund: (a) => (isCard(a.order) ? stripe.refund(a) : base.refund(a)),
  };
}

module.exports = { createPayments, PaymentError, RefundNotSupported };
