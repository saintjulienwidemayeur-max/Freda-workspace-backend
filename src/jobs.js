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
const SUB_THRESHOLDS = [[7, 1], [3, 8], [1, 2]];          // rappels avant échéance (jours, bit) ; bit 4 = jour de l'échéance
const BALANCE_PAY_AT_DAYS_LEFT = 2;                         // paiement avec le solde : 2 jours avant l'échéance (la période suivante part de l'échéance : aucun jour perdu)
const DOMAIN_BALANCE_AT_DAYS_LEFT = 7;
const DOMAIN_RETRY_AT_DAYS_LEFT = [7, 3, 1];             // renouvellement automatique des domaines : 7 j, 3 j et 1 j avant l'expiration
const RETRY_AT_DAYS_LEFT = [0, -3, -5];                 // tentatives de prélèvement automatique : à l'échéance, puis +3 j et +5 j

function createJobs({ cfg, db, orders, mailer, mail, log, balance, plans }) {
  const daysLeft = (iso, now) => Math.ceil((new Date(iso + 'T00:00:00Z').getTime() - now.getTime()) / DAY);

  /** Adresses à prévenir : l'e-mail d'inscription ET la boîte Freda Mail créée (propriétaire d'abord) : le client voit l'alerte où qu'il lise son courrier. */
  async function contactsOf(userId, email) {
    const box = await db.get("SELECT address FROM mailboxes WHERE user_id = ? AND provider_status IN ('active','suspended') ORDER BY (role = 'Propriétaire') DESC, created_at LIMIT 1", userId);
    return [...new Set([email, box && box.address].filter(Boolean).map((a) => a.toLowerCase()))];
  }
  const notifyAll = async (userId, email, msg) => { for (const to of await contactsOf(userId, email)) await mailer.trySend({ to, ...msg }); };

  /** Paye l'offre arrivée (presque) à échéance avec le solde, sans action du client, dès que le solde suffit. Une seule tentative par période. */
  async function autoPayBalance(s, now) {
    if (daysLeft(s.renews_at, now) > BALANCE_PAY_AT_DAYS_LEFT) return false;
    const u = await db.get('SELECT * FROM users WHERE id = ?', s.user_id);
    if (!u || !u.auto_pay_balance) return false;
    const amount = orders.planAmount(s.plan, s.cycle);
    if ((await balance.get(s.user_id)) < amount - 0.00001) return false;      // pas assez : les rappels « solde insuffisant » partent plus bas
    const key = `autopay-bal-${s.user_id}-${s.renews_at}`;
    if ((await db.get('SELECT 1 FROM idempotency WHERE user_id = ? AND key = ?', s.user_id, key))) return false;
    try {
      const o = await orders.create({ user: u, system: true, idempotencyKey: key, body: { kind: 'subscription', plan: s.plan, cycle: s.cycle, renewal: true, method: 'balance' } });
      log('info', 'autopay_balance', { userId: s.user_id, status: o.status });
    } catch (e) { log('warn', 'autopay_balance_failed', { userId: s.user_id, message: e.message }); }
    const after = await db.get('SELECT renews_at FROM subscriptions WHERE user_id = ?', s.user_id);
    return !!after && after.renews_at !== s.renews_at;
  }

  /** Renouvelle 1 an un domaine avec le solde, 7 jours avant l'expiration (un domaine échu entre en période de rédemption, plus chère). */
  async function autoRenewDomainBalance(d, now) {
    if (daysLeft(d.expires_at, now) > DOMAIN_BALANCE_AT_DAYS_LEFT) return false;
    const u = await db.get('SELECT * FROM users WHERE id = ?', d.user_id);
    if (!u || !u.auto_pay_balance) return false;
    const amount = await orders.renewalAmount(d.user_id, d.name, 1);
    if (amount === null || (await balance.get(d.user_id)) < amount - 0.00001) return false;
    if ((await db.get("SELECT 1 FROM orders WHERE kind = 'renewal' AND status IN ('awaiting_payment','fulfilling') AND payload LIKE ?", `%"domain":"${d.name}"%`))) return false;
    const key = `autopay-bal-dom-${d.id}-${d.expires_at}`;
    if ((await db.get('SELECT 1 FROM idempotency WHERE user_id = ? AND key = ?', d.user_id, key))) return false;
    try {
      const o = await orders.create({ user: u, system: true, idempotencyKey: key, body: { kind: 'renewal', domain: d.name, years: 1, method: 'balance' } });
      log('info', 'autopay_balance_domain', { domain: d.name, status: o.status });
    } catch (e) { log('warn', 'autopay_balance_domain_failed', { domain: d.name, message: e.message }); }
    const after = await db.get('SELECT expires_at FROM domains WHERE id = ?', d.id);
    return !!after && after.expires_at !== d.expires_at;
  }

  /** Après une recharge : paie tout de suite ce qui est dû (offre échue ou presque, domaine proche de l'expiration). */
  async function payForUser(userId, now = new Date()) {
    let n = 0;
    const s = await db.get("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','past_due','suspended') AND cancel_at_period_end = 0", userId);
    if (s && await autoPayBalance(s, now)) n++;
    for (const d of await db.all("SELECT * FROM domains WHERE user_id = ? AND external = 0 AND dry_run = 0 AND auto_renew = 1 AND status IN ('active','expired') AND expires_at <> ''", userId)) if (await autoRenewDomainBalance(d, now)) n++;
    return n;
  }

  /** Renouvelle 1 an un domaine sur la carte enregistrée, quelques jours AVANT l'expiration (un domaine échu entre en période de rédemption, plus chère). Retourne true si renouvelé. */
  async function autoRenewDomain(d, now) {
    if (!orders.cardsEnabled) return false;
    const left = daysLeft(d.expires_at, now);
    const attempt = DOMAIN_RETRY_AT_DAYS_LEFT.filter((x) => left <= x).length;
    if (!attempt) return false;
    const card = await db.get("SELECT id FROM payment_methods WHERE user_id = ? AND type = 'card' AND stripe_pm <> '' ORDER BY is_default DESC, created_at LIMIT 1", d.user_id);
    if (!card) return false;
    if ((await db.get("SELECT 1 FROM orders WHERE kind = 'renewal' AND status IN ('awaiting_payment','fulfilling') AND payload LIKE ?", `%"domain":"${d.name}"%`))) return false;   // un paiement manuel est déjà en cours
    const key = `autorenew-dom-${d.id}-${d.expires_at}-${attempt}`;
    if ((await db.get('SELECT 1 FROM idempotency WHERE user_id = ? AND key = ?', d.user_id, key))) return false;
    const user = await db.get('SELECT * FROM users WHERE id = ?', d.user_id);
    try {
      const o = await orders.create({ user, system: true, idempotencyKey: key, body: { kind: 'renewal', domain: d.name, years: 1, method: 'card', methodId: card.id } });
      log('info', 'autorenew_domain', { domain: d.name, attempt, status: o.status });
    } catch (e) { log('warn', 'autorenew_domain_failed', { domain: d.name, attempt, message: e.message }); }
    const after = await db.get('SELECT expires_at FROM domains WHERE id = ?', d.id);
    return !!after && after.expires_at !== d.expires_at;
  }

  async function domainReminders(now) {
    let sent = 0;
    const rows = await db.all("SELECT d.*, u.email, u.name AS uname FROM domains d JOIN users u ON u.id = d.user_id WHERE d.external = 0 AND d.dry_run = 0 AND d.status IN ('active','expired') AND d.expires_at <> ''");
    for (const d of rows) {
      const left = daysLeft(d.expires_at, now);
      const user = { name: d.uname };
      if (left < 0 && d.status === 'active') await db.run("UPDATE domains SET status = 'expired' WHERE id = ?", d.id);
      // renouvellement automatique désactivé : on ne prélève rien, mais le client reçoit toujours les rappels (sinon le domaine expirerait en silence)
      if (d.auto_renew && await autoRenewDomainBalance(d, now)) continue; // renouvelé avec le solde : aucun rappel
      if (d.auto_renew && await autoRenewDomain(d, now)) continue;       // renouvelé sur la carte enregistrée : aucun rappel
      const link = `${cfg.appUrl}/espace/domaines.html?renew=${encodeURIComponent(d.name)}`;
      if (left <= 0 && !(d.renewal_notices & 16)) { await mailer.trySend({ to: d.email, ...templates.domainExpiring(user, d.name, 0, link) }); await db.run('UPDATE domains SET renewal_notices = renewal_notices | 16 WHERE id = ?', d.id); sent++; continue; }
      const due = THRESHOLDS.filter(([days, bit]) => left <= days && left > 0 && !(d.renewal_notices & bit));
      if (!due.length) continue;
      await mailer.trySend({ to: d.email, ...templates.domainExpiring(user, d.name, left, link) });
      await db.run('UPDATE domains SET renewal_notices = renewal_notices | ? WHERE id = ?', due.reduce((m, [, bit]) => m | bit, 0), d.id);
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
    const card = await db.get("SELECT id FROM payment_methods WHERE user_id = ? AND type = 'card' AND stripe_pm <> '' ORDER BY is_default DESC, created_at LIMIT 1", s.user_id);
    if (!card) return false;
    const key = `autorenew-${s.user_id}-${s.renews_at}-${attempt}`;
    if ((await db.get('SELECT 1 FROM idempotency WHERE user_id = ? AND key = ?', s.user_id, key))) return false;   // déjà tentée
    const user = await db.get('SELECT * FROM users WHERE id = ?', s.user_id);
    try {
      const o = await orders.create({ user, system: true, idempotencyKey: key, body: { kind: 'subscription', plan: s.plan, cycle: s.cycle, renewal: true, method: 'card', methodId: card.id } });
      log('info', 'autorenew', { userId: s.user_id, attempt, status: o.status });
    } catch (e) { log('warn', 'autorenew_failed', { userId: s.user_id, attempt, message: e.message }); }
    const after = await db.get('SELECT renews_at FROM subscriptions WHERE user_id = ?', s.user_id);
    return !!after && after.renews_at !== s.renews_at;
  }

  async function subscriptionDue(now) {
    let sent = 0;
    const rows = await db.all("SELECT s.*, u.email, u.name AS uname FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status IN ('active','past_due')");
    for (const s of rows) {
      const left = daysLeft(s.renews_at, now);
      const plan0 = cfg.plans[s.plan].name;
      if (s.cancel_at_period_end) {                       // résiliée : jamais de prélèvement ni de rappel ; à la fin de la période payée -> « cancelled » (boîtes suspendues plus bas)
        if (left < 0) {
          await db.run("UPDATE subscriptions SET status = 'cancelled' WHERE user_id = ?", s.user_id);
          await mailer.trySend({ to: s.email, ...templates.mailboxesSuspended({ name: s.uname }, plan0, `${cfg.appUrl}/espace/facturation.html`) });
          log('info', 'subscription_cancelled_ended', { userId: s.user_id });
        }
        continue;
      }
      if (await autoPayBalance(s, now)) continue;                       // payée avec le solde (même une offre déjà suspendue : le paiement la rouvre)
      if (s.status !== 'suspended' && await autoCharge(s, now)) continue;   // renouvelée automatiquement : ni « past_due » ni rappel
      const user = { name: s.uname };
      const link = `${cfg.appUrl}/espace/facturation.html?renew=1`;
      const plan = cfg.plans[s.plan].name;
      if (left < 0 && s.status === 'active') await db.run("UPDATE subscriptions SET status = 'past_due' WHERE user_id = ?", s.user_id);
      if (left < -7 && s.status !== 'suspended') {
        await db.run("UPDATE subscriptions SET status = 'suspended' WHERE user_id = ?", s.user_id);
        await mailer.trySend({ to: s.email, ...templates.mailboxesSuspended(user, plan, link) });
        log('warn', 'subscription_suspended', { userId: s.user_id }); continue;
      }
      const price = orders.planAmount(s.plan, s.cycle);
      const have = await balance.get(s.user_id);
      const topupLink = `${cfg.appUrl}/espace/facturation.html?topup=${Math.max(cfg.balance.min, Math.ceil(price - have))}`;
      /** « Solde insuffisant » (e-mail d'inscription + boîte Freda Mail) ; si le solde suffit mais que le paiement automatique est coupé, simple rappel de paiement. */
      const remind = async (days) => {
        if (have < price - 0.00001) {
          const missing = Math.round((price - have) * 100) / 100;
          await notifyAll(s.user_id, s.email, templates.balanceLow(user, { plan, days, price, balance: have, missing, missingHtg: Math.ceil(missing * cfg.pricing.htgRate), link: topupLink }));
        } else await notifyAll(s.user_id, s.email, templates.subscriptionDue(user, plan, days, link));
      };
      if (left <= 0 && !(s.notices & 4)) { await remind(0); await db.run('UPDATE subscriptions SET notices = notices | 4 WHERE user_id = ?', s.user_id); sent++; continue; }
      const due = SUB_THRESHOLDS.filter(([days, bit]) => left <= days && left > 0 && !(s.notices & bit));
      if (!due.length) continue;
      await remind(left);
      await db.run('UPDATE subscriptions SET notices = notices | ? WHERE user_id = ?', due.reduce((m, [, bit]) => m | bit, 0), s.user_id);
      sent++;
    }
    return sent;
  }

  /** Applique réellement les suspensions : toute offre « suspended » / « cancelled » dont des boîtes sont encore ouvertes (y compris après un échec précédent). */
  async function enforceSuspensions() {
    let n = 0;
    for (const r of await db.all("SELECT DISTINCT s.user_id FROM subscriptions s JOIN mailboxes m ON m.user_id = s.user_id WHERE s.status IN ('suspended','cancelled') AND m.provider_status = 'active'")) {
      const out = await mail.suspendMailboxes(r.user_id); n += out.suspended;
    }
    for (const r of await db.all("SELECT DISTINCT user_id FROM mailboxes WHERE rule_state IN ('pending','cleanup')")) await mail.reconcileRules(r.user_id);   // règles de routage à poser / retirer (échecs précédents)
    return n;
  }

  async function runOnce(now = new Date()) {
    const out = {};
    if (plans) await plans.ready;
    try { out.sweep = await orders.sweep(); } catch (e) { log('error', 'job_sweep_failed', { message: e.message }); }
    if (cfg.renewals.enabled) {
      try { out.domainReminders = await domainReminders(now); } catch (e) { log('error', 'job_domains_failed', { message: e.message }); }
      try { out.subscriptionReminders = await subscriptionDue(now); } catch (e) { log('error', 'job_subs_failed', { message: e.message }); }
      try { out.suspended = await enforceSuspensions(); } catch (e) { log('error', 'job_suspend_failed', { message: e.message }); }
    }
    return out;
  }

  /** Une seule exécution à la fois (minuteur + endpoint admin + démarrage) : sinon un même rappel pourrait partir deux fois. */
  let running = false;
  async function run(...args) {
    if (running) return { skipped: true };
    running = true;
    try { return await runOnce(...args); } finally { running = false; }
  }

  let timer = null;
  return {
    run, payForUser,
    start() {
      if (timer) return;
      timer = setInterval(() => run().catch(() => {}), cfg.renewals.intervalMs); timer.unref();
      setTimeout(() => run().catch(() => {}), 60_000).unref();   // premier passage 1 min après le démarrage : un redémarrage (déploiement, réveil) ne repousse plus les échéances de 6 h
    },
    /** Balayage rapide des paiements Pay'm (toutes les minutes) : un client qui ferme l'onglet est quand même servi. */
    startSweeper() { const t = setInterval(async () => orders.sweep().catch(() => {}), 60 * 1000); t.unref(); return t; },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createJobs };
