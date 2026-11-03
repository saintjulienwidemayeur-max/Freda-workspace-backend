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
const DOMAIN_RETRY_AT_DAYS_LEFT = [7, 3, 1];             // renouvellement automatique des domaines : 7 j, 3 j et 1 j avant l'expiration
const RETRY_AT_DAYS_LEFT = [0, -3, -5];                 // tentatives de prélèvement automatique : à l'échéance, puis +3 j et +5 j

function createJobs({ cfg, db, orders, mailer, mail, log }) {
  const daysLeft = (iso, now) => Math.ceil((new Date(iso + 'T00:00:00Z').getTime() - now.getTime()) / DAY);

  /** Renouvelle 1 an un domaine sur la carte enregistrée, quelques jours AVANT l'expiration (un domaine échu entre en période de rédemption, plus chère). Retourne true si renouvelé. */
  async function autoRenewDomain(d, now) {
    if (!orders.cardsEnabled) return false;
    const left = daysLeft(d.expires_at, now);
    const attempt = DOMAIN_RETRY_AT_DAYS_LEFT.filter((x) => left <= x).length;
    if (!attempt) return false;
    const card = db.get("SELECT id FROM payment_methods WHERE user_id = ? AND type = 'card' AND stripe_pm <> '' ORDER BY is_default DESC, created_at LIMIT 1", d.user_id);
    if (!card) return false;
    if (db.get("SELECT 1 FROM orders WHERE kind = 'renewal' AND status IN ('awaiting_payment','fulfilling') AND payload LIKE ?", `%"domain":"${d.name}"%`)) return false;   // un paiement manuel est déjà en cours
    const key = `autorenew-dom-${d.id}-${d.expires_at}-${attempt}`;
    if (db.get('SELECT 1 FROM idempotency WHERE user_id = ? AND key = ?', d.user_id, key)) return false;
    const user = db.get('SELECT * FROM users WHERE id = ?', d.user_id);
    try {
      const o = await orders.create({ user, system: true, idempotencyKey: key, body: { kind: 'renewal', domain: d.name, years: 1, method: 'card', methodId: card.id } });
      log('info', 'autorenew_domain', { domain: d.name, attempt, status: o.status });
    } catch (e) { log('warn', 'autorenew_domain_failed', { domain: d.name, attempt, message: e.message }); }
    const after = db.get('SELECT expires_at FROM domains WHERE id = ?', d.id);
    return !!after && after.expires_at !== d.expires_at;
  }

  async function domainReminders(now) {
    let sent = 0;
    const rows = db.all("SELECT d.*, u.email, u.name AS uname FROM domains d JOIN users u ON u.id = d.user_id WHERE d.external = 0 AND d.dry_run = 0 AND d.status IN ('active','expired') AND d.expires_at <> ''");
    for (const d of rows) {
      const left = daysLeft(d.expires_at, now);
      const user = { name: d.uname };
      if (left < 0 && d.status === 'active') db.run("UPDATE domains SET status = 'expired' WHERE id = ?", d.id);
      if (!d.auto_renew) continue;                       // le client a désactivé le renouvellement automatique et les rappels pour ce domaine
      if (await autoRenewDomain(d, now)) continue;       // renouvelé sur la carte enregistrée : aucun rappel
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

  /**
   * Prélèvement automatique d'une offre arrivée à échéance sur la carte enregistrée (Stripe, sans action du client).
   * Une clé d'idempotence par période ET par tentative : jamais de double débit, 3 tentatives maximum. Retourne true si l'offre est renouvelée.
   */
  async function autoCharge(s, now) {
    if (!orders.cardsEnabled) return false;
    const left = daysLeft(s.renews_at, now);
    const attempt = RETRY_AT_DAYS_LEFT.filter((d) => left <= d).length;     // 0 = pas encore échu
    if (!attempt) return false;
    const card = db.get("SELECT id FROM payment_methods WHERE user_id = ? AND type = 'card' AND stripe_pm <> '' ORDER BY is_default DESC, created_at LIMIT 1", s.user_id);
    if (!card) return false;
    const key = `autorenew-${s.user_id}-${s.renews_at}-${attempt}`;
    if (db.get('SELECT 1 FROM idempotency WHERE user_id = ? AND key = ?', s.user_id, key)) return false;   // déjà tentée
    const user = db.get('SELECT * FROM users WHERE id = ?', s.user_id);
    try {
      const o = await orders.create({ user, system: true, idempotencyKey: key, body: { kind: 'subscription', plan: s.plan, cycle: s.cycle, renewal: true, method: 'card', methodId: card.id } });
      log('info', 'autorenew', { userId: s.user_id, attempt, status: o.status });
    } catch (e) { log('warn', 'autorenew_failed', { userId: s.user_id, attempt, message: e.message }); }
    const after = db.get('SELECT renews_at FROM subscriptions WHERE user_id = ?', s.user_id);
    return !!after && after.renews_at !== s.renews_at;
  }

  async function subscriptionDue(now) {
    let sent = 0;
    const rows = db.all("SELECT s.*, u.email, u.name AS uname FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status IN ('active','past_due')");
    for (const s of rows) {
      const left = daysLeft(s.renews_at, now);
      const plan0 = cfg.plans[s.plan].name;
      if (s.cancel_at_period_end) {                       // résiliée : jamais de prélèvement ni de rappel ; à la fin de la période payée -> « cancelled » (boîtes suspendues plus bas)
        if (left < 0) {
          db.run("UPDATE subscriptions SET status = 'cancelled' WHERE user_id = ?", s.user_id);
          await mailer.trySend({ to: s.email, ...templates.mailboxesSuspended({ name: s.uname }, plan0, `${cfg.appUrl}/espace/facturation.html`) });
          log('info', 'subscription_cancelled_ended', { userId: s.user_id });
        }
        continue;
      }
      if (s.status !== 'suspended' && await autoCharge(s, now)) continue;   // renouvelée automatiquement : ni « past_due » ni rappel
      const user = { name: s.uname };
      const link = `${cfg.appUrl}/espace/facturation.html?renew=1`;
      const plan = cfg.plans[s.plan].name;
      if (left < 0 && s.status === 'active') db.run("UPDATE subscriptions SET status = 'past_due' WHERE user_id = ?", s.user_id);
      if (left < -7 && s.status !== 'suspended') {
        db.run("UPDATE subscriptions SET status = 'suspended' WHERE user_id = ?", s.user_id);
        await mailer.trySend({ to: s.email, ...templates.mailboxesSuspended(user, plan, link) });
        log('warn', 'subscription_suspended', { userId: s.user_id }); continue;
      }
      if (left <= 0 && !(s.notices & 4)) { await mailer.trySend({ to: s.email, ...templates.subscriptionDue(user, plan, 0, link) }); db.run('UPDATE subscriptions SET notices = notices | 4 WHERE user_id = ?', s.user_id); sent++; continue; }
      const due = SUB_THRESHOLDS.filter(([days, bit]) => left <= days && left > 0 && !(s.notices & bit));
      if (!due.length) continue;
      await mailer.trySend({ to: s.email, ...templates.subscriptionDue(user, plan, left, link) });
      db.run('UPDATE subscriptions SET notices = notices | ? WHERE user_id = ?', due.reduce((m, [, bit]) => m | bit, 0), s.user_id);
      sent++;
    }
    return sent;
  }

  /** Applique réellement les suspensions : toute offre « suspended » / « cancelled » dont des boîtes sont encore ouvertes (y compris après un échec précédent). */
  async function enforceSuspensions() {
    let n = 0;
    for (const r of db.all("SELECT DISTINCT s.user_id FROM subscriptions s JOIN mailboxes m ON m.user_id = s.user_id WHERE s.status IN ('suspended','cancelled') AND m.provider_status = 'active'")) {
      const out = await mail.suspendMailboxes(r.user_id); n += out.suspended;
    }
    for (const r of db.all("SELECT DISTINCT user_id FROM mailboxes WHERE rule_state IN ('pending','cleanup')")) await mail.reconcileRules(r.user_id);   // règles de routage à poser / retirer (échecs précédents)
    return n;
  }

  async function run(now = new Date()) {
    const out = {};
    try { out.sweep = await orders.sweep(); } catch (e) { log('error', 'job_sweep_failed', { message: e.message }); }
    if (cfg.renewals.enabled) {
      try { out.domainReminders = await domainReminders(now); } catch (e) { log('error', 'job_domains_failed', { message: e.message }); }
      try { out.subscriptionReminders = await subscriptionDue(now); } catch (e) { log('error', 'job_subs_failed', { message: e.message }); }
      try { out.suspended = await enforceSuspensions(); } catch (e) { log('error', 'job_suspend_failed', { message: e.message }); }
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
