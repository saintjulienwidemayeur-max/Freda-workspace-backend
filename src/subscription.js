/**
 * Résiliation / reprise de l'offre Freda Mail.
 *  - cancel : plus aucun prélèvement ni rappel ; les boîtes restent utilisables jusqu'à la fin de la période PAYÉE, puis sont suspendues (jamais supprimées).
 *  - resume : possible tant que la période payée n'est pas terminée. Après, il suffit de se réabonner (les boîtes suspendues rouvrent au paiement).
 */
const { HttpError } = require('./errors');
const { templates } = require('./mailer');

function createSubscription({ cfg, db, mailer }) {
  const get = (userId) => {
    const s = db.get('SELECT * FROM subscriptions WHERE user_id = ?', userId);
    if (!s) throw new HttpError(404, 'Aucune offre Freda Mail.', 'no_subscription');
    return s;
  };
  const view = (userId) => { const s = get(userId); return { plan: s.plan, cycle: s.cycle, renews: s.renews_at, status: s.status, cancelAtPeriodEnd: !!s.cancel_at_period_end }; };
  const activity = (userId, icon, text) => db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, icon, text, new Date().toISOString().slice(0, 16).replace('T', ' '));

  async function cancel(userId) {
    const s = get(userId);
    if (!['active', 'past_due'].includes(s.status)) throw new HttpError(409, 'Cette offre n’est plus active.', 'not_active');
    if (s.cancel_at_period_end) return view(userId);
    db.run('UPDATE subscriptions SET cancel_at_period_end = 1 WHERE user_id = ?', userId);
    activity(userId, 'circle-slash', `Offre ${cfg.plans[s.plan].name} résiliée : active jusqu’au ${s.renews_at}`);
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    mailer.trySend({ to: u.email, ...templates.subscriptionCancelled(u, cfg.plans[s.plan].name, s.renews_at, `${cfg.appUrl}/espace/facturation.html`) });
    return view(userId);
  }

  async function resume(userId) {
    const s = get(userId);
    if (!s.cancel_at_period_end) return view(userId);
    if (s.status === 'cancelled' || s.status === 'suspended') throw new HttpError(409, 'La période est terminée : souscrivez à nouveau une offre.', 'period_ended');
    db.run('UPDATE subscriptions SET cancel_at_period_end = 0 WHERE user_id = ?', userId);
    activity(userId, 'rotate-ccw', `Résiliation de l’offre ${cfg.plans[s.plan].name} annulée`);
    return view(userId);
  }

  return { cancel, resume, view };
}

module.exports = { createSubscription };
