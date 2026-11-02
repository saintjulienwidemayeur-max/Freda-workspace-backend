/**
 * Moyens de paiement. Le fournisseur réel (Freda Pay : carte, MonCash, NatCash) reste à brancher ici :
 * implémentez charge() et refund() dans createFredaPay(). Tant qu'il n'est pas prêt, seul « demo »
 * (qui approuve tout) existe, et il est INTERDIT avec NAMESILO_MODE=live (voir config.assertSafe).
 */
class PaymentError extends Error {
  constructor(message, status = 402) { super(message); this.name = 'PaymentError'; this.status = status; }
}

function createDemo() {
  return {
    name: 'demo',
    async charge({ amount, reference }) {
      if (!(amount > 0)) throw new PaymentError('Montant invalide.');
      return { id: 'demo_' + reference, amount };
    },
    async refund({ chargeId }) { return { id: 'refund_' + chargeId }; },
  };
}

function createFredaPay() {
  const todo = () => { throw new PaymentError('Freda Pay n’est pas encore branché côté serveur.', 501); };
  return { name: 'fredapay', charge: todo, refund: todo };
}

function createPayments(cfg) {
  if (cfg.payments.provider === 'fredapay') return createFredaPay(cfg);
  if (cfg.payments.provider === 'demo') return createDemo();
  throw new Error('PAYMENTS_PROVIDER inconnu : ' + cfg.payments.provider);
}

module.exports = { createPayments, PaymentError };
