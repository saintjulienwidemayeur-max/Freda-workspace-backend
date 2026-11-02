/**
 * Tâches périodiques :
 *  1. balayage des paiements en attente (confirmation / expiration) ;
 *  2. rappels d'expiration des domaines (30, 14, 7, 1 jours) et marquage « expired » ;
 *  3. échéances des offres Freda Mail (rappels à 5 et 1 jours, « past_due » à l'échéance, « suspended » après 7 jours).
 * Les rappels pointent vers le site (…/domaines.html?renew=nom) : le lien de paiement Pay'm est créé AU CLIC, donc toujours frais.
 * Les domaines du mode dry-run ne sont pas de vrais domaines : ils sont ignorés.
 */
const { templates } = require('./mailer');

const DAY = 86400000;
const THRESHOLDS = [[30, 1], [14, 2], [7, 4], [1, 8]];     // [jours restants, bit déjà notifié]
const SUB_THRESHOLDS = [[5, 1], [1, 2]];

function createJobs({ cfg, db, orders, mailer, log }) {
  const daysLeft = (iso, now) => Math.ceil((new Date(iso + 'T00:00:00Z').getTime() - now.getTime()) / DAY);

  async function domainReminders(now) {
    let sent = 0;
    const rows = db.all("SELECT d.*, u.email, u.name AS uname FROM domains d JOIN users u ON u.id = d.user_id WHERE d.external = 0 AND d.dry_run = 0 AND d.status IN ('active','expired') AND d.expires_at <> ''");
    for (const d of rows) {
      const left = daysLeft(d.expires_at, now);
      const user = { name: d.uname };
      if (left < 0 && d.status === 'active') db.run("UPDATE domains SET status = 'expired' WHERE id = ?", d.id);
      if (!d.auto_renew) continue;                       // le client a désactivé les rappels pour ce domaine
      const link = `${cfg.appUrl}/espace/domaines.html?renew=${encodeURIComponent(d.name)}`;
      if (left <= 0 && !(d.renewal_notices & 16)) { await mailer.trySend({ to: d.email, ...templates.domainExpiring(user, d.name, 0, link) }); db.run('UPDATE domains SET renewal_notices = renewal_notices | 16 WHERE id = ?', d.id); sent++; continue; }
      const due = THRESHOLDS.filter(([days, bit]) => left <= days && left > 0 && !(d.renewal_notices & bit));
      if (!due.length) continue;
      await mailer.trySend({ to: d.email, ...templates.domainExpiring(user, d.name, left, link) });
      db.run('UPDATE domains SET renewal_notices = renewal_notices | ? WHERE id = ?', due.reduce((m, [, bit]) => m | bit, 0), d.id);
      sent++;
    }
    return sent;
  }

  async function subscriptionDue(now) {
    let sent = 0;
    const rows = db.all("SELECT s.*, u.email, u.name AS uname FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status IN ('active','past_due')");
    for (const s of rows) {
      const left = daysLeft(s.renews_at, now);
      const user = { name: s.uname };
      const link = `${cfg.appUrl}/espace/facturation.html?renew=1`;
      const plan = cfg.plans[s.plan].name;
      if (left < 0 && s.status === 'active') db.run("UPDATE subscriptions SET status = 'past_due' WHERE user_id = ?", s.user_id);
      if (left < -7 && s.status !== 'suspended') { db.run("UPDATE subscriptions SET status = 'suspended' WHERE user_id = ?", s.user_id); log('warn', 'subscription_suspended', { userId: s.user_id }); continue; }
      if (left <= 0 && !(s.notices & 4)) { await mailer.trySend({ to: s.email, ...templates.subscriptionDue(user, plan, 0, link) }); db.run('UPDATE subscriptions SET notices = notices | 4 WHERE user_id = ?', s.user_id); sent++; continue; }
      const due = SUB_THRESHOLDS.filter(([days, bit]) => left <= days && left > 0 && !(s.notices & bit));
      if (!due.length) continue;
      await mailer.trySend({ to: s.email, ...templates.subscriptionDue(user, plan, left, link) });
      db.run('UPDATE subscriptions SET notices = notices | ? WHERE user_id = ?', due.reduce((m, [, bit]) => m | bit, 0), s.user_id);
      sent++;
    }
    return sent;
  }

  async function run(now = new Date()) {
    const out = {};
    try { out.sweep = await orders.sweep(); } catch (e) { log('error', 'job_sweep_failed', { message: e.message }); }
    if (cfg.renewals.enabled) {
      try { out.domainReminders = await domainReminders(now); } catch (e) { log('error', 'job_domains_failed', { message: e.message }); }
      try { out.subscriptionReminders = await subscriptionDue(now); } catch (e) { log('error', 'job_subs_failed', { message: e.message }); }
    }
    return out;
  }

  let timer = null;
  return {
    run,
    start() { if (timer) return; timer = setInterval(() => run().catch(() => {}), cfg.renewals.intervalMs); timer.unref(); },
    /** Balayage rapide des paiements Pay'm (toutes les minutes) : un client qui ferme l'onglet est quand même servi. */
    startSweeper() { const t = setInterval(() => orders.sweep().catch(() => {}), 60 * 1000); t.unref(); return t; },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createJobs };
