/**
 * Outils de l'administrateur (ADMIN_TOKEN) :
 *  1. OFFRIR une offre Freda Mail à un client, pour un nombre de mois choisi, sans paiement (journal admin_grants) ;
 *  2. ANNONCE par e-mail à tous les clients (ou à un groupe) : envoi de test, confirmation du nombre de destinataires, envoi lent et reprenable.
 *
 * Offre offerte : l'abonnement est « résilié en fin de période » (cancel_at_period_end = 1) : à l'échéance il s'arrête tout seul, sans aucun prélèvement
 * (ni sur le solde, ni sur la carte). Exception : prolonger la MÊME offre d'un client qui paie déjà ne coupe pas son renouvellement.
 * Annonce : chaque (annonce, client) n'est enregistré qu'une fois AVANT l'envoi : un redémarrage ne peut jamais renvoyer le message deux fois.
 */
const crypto = require('crypto');
const { HttpError } = require('./errors');
const { cycleOf } = require('./plans');
const { nm } = require('./mailer');

const MAX_MONTHS = 36;
const AUDIENCES = {
  all: { label: 'Tous les clients', from: 'users u', where: "u.email <> ''" },
  verified: { label: 'Clients à l’adresse confirmée', from: 'users u', where: "u.email <> '' AND u.email_verified = 1" },
  subscribers: { label: 'Clients avec une offre active', from: 'users u JOIN subscriptions s ON s.user_id = u.id', where: "u.email <> '' AND s.status IN ('active','past_due')" },
  no_subscription: { label: 'Clients sans offre active', from: 'users u', where: "u.email <> '' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status IN ('active','past_due'))" },
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEND_DELAY_MS = 150;
const FOOTER = 'Vous recevez ce message parce que vous avez un compte Freda Workspace.';
const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (d, n) => { const r = new Date(d); const day = r.getDate(); r.setDate(1); r.setMonth(r.getMonth() + n); r.setDate(Math.min(day, new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate())); return r; };
const iso = (d) => d.toISOString().slice(0, 10);

function createAdminTools({ cfg, db, mail, mailer, log, templates, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const running = new Set();   // annonces en cours d'envoi dans CE processus

  /* ---------- Clients ---------- */
  async function customers(q) {
    q = String(q || '').trim().toLowerCase().slice(0, 80);
    if (q.length < 2) return { customers: [] };
    const like = `%${q}%`;
    const rows = await db.all(`SELECT u.id, u.email, u.name, u.company, s.plan, s.status, s.renews_at, s.cancel_at_period_end FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ? OR LOWER(u.company) LIKE ? ORDER BY u.created_at DESC LIMIT 15`, like, like, like);
    return { customers: rows.map((r) => ({ id: r.id, email: r.email, name: r.name, company: r.company, plan: r.plan || null, planStatus: r.status || null, renews: r.renews_at || null, endsAtPeriodEnd: !!r.cancel_at_period_end })) };
  }

  /* ---------- Offrir une offre ---------- */
  const sellable = () => Object.values(cfg.plans).filter((p) => !p.free);
  function plansView() { return sellable().map((p) => ({ id: p.id, name: p.name, mailboxes: p.mailboxes === Infinity ? null : p.mailboxes })); }

  async function grant({ email, plan, months, note, notify }) {
    const p = sellable().find((x) => x.id === plan);
    if (!p) throw new HttpError(400, 'Offre inconnue.', 'invalid_plan');
    const n = Number(months);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MONTHS) throw new HttpError(400, `Durée invalide : de 1 à ${MAX_MONTHS} mois.`, 'invalid_months');
    const addr = String(email || '').trim().toLowerCase();
    if (!EMAIL.test(addr)) throw new HttpError(400, 'Adresse e-mail invalide.', 'invalid_email');
    const user = await db.get('SELECT id, email, name FROM users WHERE LOWER(email) = ?', addr);
    if (!user) throw new HttpError(404, 'Aucun client avec cette adresse e-mail.', 'not_found');
    const prev = await db.get('SELECT * FROM subscriptions WHERE user_id = ?', user.id);
    const live = prev && ['active', 'past_due'].includes(prev.status) && prev.renews_at > today();
    const extending = !!(live && prev.plan === plan);
    const start = extending ? new Date(prev.renews_at + 'T00:00:00Z') : new Date();
    const ends = iso(addMonths(start, n));
    const keepCancelFlag = extending && !prev.cancel_at_period_end;   // client qui paie déjà cette offre : son renouvellement reste actif
    const id = 'gr_' + crypto.randomBytes(8).toString('hex'), cleanNote = String(note || '').trim().slice(0, 300);
    await db.tx(async () => {
      await db.run(`INSERT INTO subscriptions (user_id, plan, cycle, status, renews_at, started_at, cancel_at_period_end) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, cycle = excluded.cycle, status = 'active', renews_at = excluded.renews_at, notices = 0, cancel_at_period_end = excluded.cancel_at_period_end`,
        user.id, plan, n <= 12 ? cycleOf(n) : 'yearly', 'active', ends, extending ? prev.started_at : today(), keepCancelFlag ? 0 : 1);
      await db.run('INSERT INTO admin_grants (id, user_id, plan, months, note, starts_on, ends_on, created_at) VALUES (?,?,?,?,?,?,?,?)', id, user.id, plan, n, cleanNote, iso(start), ends, new Date().toISOString());
      await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', user.id, 'gift', `Offre ${p.name} offerte pour ${n} mois (jusqu'au ${ends})`, new Date().toISOString().slice(0, 16).replace('T', ' '));
    });
    try { await mail.reactivateMailboxes(user.id); } catch (e) { log('warn', 'grant_reactivate_failed', { userId: user.id, message: e.message }); }   // boîtes suspendues : rouvertes
    let notified = false;
    if (notify) notified = !!(await mailer.trySend({ to: user.email, ...templates.planGift(user, { plan: p.name, months: n, endsOn: ends, mailboxes: p.mailboxes === Infinity ? null : p.mailboxes, link: `${cfg.appUrl}/espace/facturation.html` }) }));
    log('info', 'admin_plan_granted', { userId: user.id, plan, months: n, ends, extending });
    return { ok: true, grantId: id, customer: { id: user.id, email: user.email, name: user.name }, plan, planName: p.name, months: n, startsOn: iso(start), endsOn: ends, extended: extending, replaced: live && !extending ? { plan: prev.plan, renews: prev.renews_at } : null, keepsRenewal: keepCancelFlag, notified };
  }

  async function grants(limit = 30) {
    const rows = await db.all('SELECT g.id, g.plan, g.months, g.note, g.starts_on, g.ends_on, g.created_at, u.email FROM admin_grants g JOIN users u ON u.id = g.user_id ORDER BY g.created_at DESC LIMIT ?', Math.min(100, Math.max(1, Number(limit) || 30)));
    return { grants: rows.map((r) => ({ id: r.id, email: r.email, plan: r.plan, months: r.months, note: r.note, startsOn: r.starts_on, endsOn: r.ends_on, createdAt: r.created_at })) };
  }

  /* ---------- Annonces ---------- */
  const audienceOf = (key) => { const a = AUDIENCES[key]; if (!a) throw new HttpError(400, 'Groupe de destinataires inconnu.', 'invalid_audience'); return a; };
  async function audienceCount(key) {
    const a = audienceOf(key);
    return { audience: key, label: a.label, count: Number((await db.get(`SELECT COUNT(DISTINCT u.id) AS n FROM ${a.from} WHERE ${a.where}`)).n) || 0 };
  }
  function clean({ subject, message }) {
    const s = String(subject || '').replace(/[\r\n]+/g, ' ').trim(), m = String(message || '').replace(/\r\n/g, '\n').trim();
    if (s.length < 3 || s.length > 150) throw new HttpError(400, 'Le sujet doit faire de 3 à 150 caractères.', 'invalid_subject');
    if (m.length < 10 || m.length > 20000) throw new HttpError(400, 'Le message doit faire de 10 à 20 000 caractères.', 'invalid_message');
    return { s, m };
  }
  const compose = (user, subject, message) => ({ subject, text: `Bonjour${nm(user) ? ' ' + nm(user) : ''},\n\n${message}\n\n${FOOTER}` });
  const announce = (to, user, subject, message) => mailer.send({ to, ...compose(user, subject, message), category: 'Announcement' });

  async function test({ subject, message, to }) {
    const { s, m } = clean({ subject, message });
    const addr = String(to || '').trim().toLowerCase();
    if (!EMAIL.test(addr)) throw new HttpError(400, 'Adresse de test invalide.', 'invalid_email');
    try { await announce(addr, { name: '' }, s, m); } catch (e) { throw new HttpError(502, 'L’envoi du test a échoué : vérifiez la configuration e-mail (Brevo).', 'send_failed'); }
    return { ok: true, to: addr };
  }

  async function runAnnouncement(id) {
    if (running.has(id)) return;
    running.add(id);
    try {
      const a = await db.get('SELECT * FROM announcements WHERE id = ?', id);
      if (!a) return;
      const def = audienceOf(a.audience);
      for (;;) {
        const batch = await db.all(`SELECT DISTINCT u.id, u.email, u.name FROM ${def.from} WHERE ${def.where} AND NOT EXISTS (SELECT 1 FROM announcement_deliveries d WHERE d.announcement_id = ? AND d.user_id = u.id) ORDER BY u.id LIMIT 25`, id);
        if (!batch.length) break;
        for (const u of batch) {
          const ins = await db.run("INSERT INTO announcement_deliveries (announcement_id, user_id, status) VALUES (?,?,'sending') ON CONFLICT DO NOTHING", id, u.id);   // enregistré AVANT l'envoi
          if (!ins.changes) continue;
          let ok = true;
          try { await announce(u.email, u, a.subject, a.body); } catch (e) { ok = false; }
          await db.run('UPDATE announcement_deliveries SET status = ? WHERE announcement_id = ? AND user_id = ?', ok ? 'sent' : 'failed', id, u.id);
          await db.run(`UPDATE announcements SET ${ok ? 'sent = sent + 1' : 'failed = failed + 1'} WHERE id = ?`, id);
          await sleep(SEND_DELAY_MS);
        }
      }
      await db.run("UPDATE announcements SET status = 'done', finished_at = ? WHERE id = ?", new Date().toISOString(), id);
      const r = await db.get('SELECT sent, failed, total FROM announcements WHERE id = ?', id);
      log('info', 'announcement_done', { id, sent: r.sent, failed: r.failed, total: r.total });
    } catch (e) {
      log('error', 'announcement_crashed', { id, message: e.message });
    } finally { running.delete(id); }
  }

  /** Lance l'envoi à tout un groupe. expectedCount (affiché à l'administrateur) doit être exact : sinon le groupe a changé depuis, rien n'est envoyé. */
  async function create({ subject, message, audience, expectedCount }) {
    const { s, m } = clean({ subject, message });
    const { count } = await audienceCount(audience);
    if (!(count > 0)) throw new HttpError(409, 'Aucun destinataire dans ce groupe.', 'no_recipients');
    if (Number(expectedCount) !== count) throw new HttpError(409, `Le nombre de destinataires a changé (${count} maintenant). Vérifiez et recommencez.`, 'audience_changed', { count });
    if (running.size) throw new HttpError(409, 'Une annonce est déjà en cours d’envoi : attendez qu’elle se termine.', 'announcement_running');
    const id = 'ann_' + crypto.randomBytes(8).toString('hex');
    await db.run("INSERT INTO announcements (id, subject, body, audience, total, status, created_at) VALUES (?,?,?,?,?,'sending',?)", id, s, m, audience, count, new Date().toISOString());
    log('info', 'announcement_started', { id, audience, total: count });
    void runAnnouncement(id);
    return { ok: true, id, total: count };
  }

  /** Reprise d'une annonce interrompue (redémarrage du serveur) ; retryFailed : réessaie aussi les envois échoués. Jamais de doublon. */
  async function resume(id, { retryFailed = false } = {}) {
    const a = await db.get('SELECT * FROM announcements WHERE id = ?', String(id));
    if (!a) throw new HttpError(404, 'Annonce introuvable.', 'not_found');
    if (running.has(a.id)) throw new HttpError(409, 'Cette annonce est déjà en cours d’envoi.', 'announcement_running');
    if (running.size) throw new HttpError(409, 'Une autre annonce est en cours d’envoi.', 'announcement_running');
    if (retryFailed) {
      await db.run("DELETE FROM announcement_deliveries WHERE announcement_id = ? AND status = 'failed'", a.id);
      await db.run("UPDATE announcements SET failed = (SELECT COUNT(*) FROM announcement_deliveries WHERE announcement_id = ? AND status = 'failed') WHERE id = ?", a.id, a.id);
    }
    await db.run("UPDATE announcements SET status = 'sending', finished_at = '' WHERE id = ?", a.id);
    void runAnnouncement(a.id);
    return { ok: true, id: a.id };
  }

  async function announcements() {
    const rows = await db.all('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 20');
    return { announcements: rows.map((r) => ({ id: r.id, subject: r.subject, audience: r.audience, audienceLabel: (AUDIENCES[r.audience] || {}).label || r.audience, total: r.total, sent: r.sent, failed: r.failed, status: r.status === 'sending' && !running.has(r.id) ? 'interrupted' : r.status, createdAt: r.created_at, finishedAt: r.finished_at || null })), audiences: Object.entries(AUDIENCES).map(([key, v]) => ({ key, label: v.label })) };
  }

  return { customers, plansView, grant, grants, audienceCount, test, create, resume, announcements, maxMonths: MAX_MONTHS, whenIdle: async () => { while (running.size) await new Promise((r) => setTimeout(r, 20)); } };
}

module.exports = { createAdminTools, MAX_MONTHS, AUDIENCES };
