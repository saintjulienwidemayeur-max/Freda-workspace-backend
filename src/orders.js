/**
 * Commandes : domaine, offre Freda Mail (abonnement) et renouvellement de domaine.
 *
 * États : awaiting_payment -> fulfilling -> completed | partially_refunded | refunded | needs_attention
 *         (+ payment_failed, expired). Le paiement Pay'm est asynchrone (redirection) : la commande reste « awaiting_payment » jusqu'à
 *         ce que verify() confirme, soit à la demande du client (GET /orders/:id), soit par le balayage périodique (sweep).
 * Les prix sont TOUJOURS recalculés ici ; le montant envoyé par le navigateur est ignoré.
 */
const crypto = require('crypto');
const { HttpError } = require('./errors');
const { PaymentError, RefundNotSupported } = require('./payments');
const { templates } = require('./mailer');

const r2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const OPEN = ['awaiting_payment', 'fulfilling'];
const EXPIRE_MS = 2 * 3600 * 1000;

function createOrders({ cfg, db, payments, catalog, registrar, dns, mail, mailer, alert, log }) {
  const parse = (o) => ({ ...o, payload: JSON.parse(o.payload || '{}') });

  function summarize(o, extra = {}) {
    const p = o.payload || JSON.parse(o.payload || '{}');
    const base = { orderId: o.id, reference: o.reference, kind: o.kind, amount: o.amount, currency: o.currency, orderStatus: o.status, dryRun: !!o.dry_run };
    if (o.status === 'awaiting_payment' || o.status === 'fulfilling') return { ...base, status: 'pending', redirectUrl: o.redirect_url || undefined, ...extra };
    if (['completed', 'partially_refunded'].includes(o.status)) return { ...base, status: 'succeeded', domains: p.done || (p.lines || []).map((l) => l.name), failed: p.failed || [], plan: p.plan, domain: p.domain, ...extra };
    return { ...base, status: 'failed', error: o.error || undefined, ...extra };
  }

  function nextInvoiceId() {
    const y = new Date().getFullYear();
    const n = db.get('SELECT COUNT(*) AS n FROM invoices WHERE id LIKE ?', `FW-${y}-%`).n + 1;
    return `FW-${y}-${String(n).padStart(4, '0')}`;
  }
  function addInvoice(userId, { label, amount, method, status = 'paid', orderId }) {
    const invId = nextInvoiceId();
    db.run('INSERT INTO invoices (id, user_id, date, label, amount, method, status, order_id) VALUES (?,?,?,?,?,?,?,?)', invId, userId, today(), label, amount, method, status, orderId);
    return invId;
  }
  const activity = (userId, icon, text) => db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, icon, text, stamp());
  const setOrder = (id, patch) => {
    const keys = Object.keys(patch);
    db.run(`UPDATE orders SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (k === 'payload' ? JSON.stringify(patch[k]) : patch[k])), new Date().toISOString(), id);
  };
  const methodLabel = (m) => ({ moncash: 'MonCash', natcash: 'NatCash', card: 'Carte', all: 'MonCash / NatCash' }[m] || m);

  function planAmount(planId, cycle) {
    const p = cfg.plans[planId];
    if (!p) throw new HttpError(400, 'Offre inconnue.', 'invalid_plan');
    if (!['monthly', 'yearly'].includes(cycle)) throw new HttpError(400, 'Période de facturation inconnue.', 'invalid_cycle');
    return r2(cycle === 'yearly' ? p.monthly * cfg.pricing.yearlyMonthsBilled : p.monthly);
  }

  /* ---------- Création ---------- */
  async function create({ user, body, idempotencyKey, system = false }) {
    const kind = body.kind;
    if (!['domain', 'subscription', 'renewal'].includes(kind)) throw new HttpError(400, 'Type d’achat non pris en charge.', 'unsupported_kind');
    if (idempotencyKey) {
      const prev = db.get('SELECT order_id FROM idempotency WHERE user_id = ? AND key = ?', user.id, idempotencyKey);
      if (prev) return summarize(parse(db.get('SELECT * FROM orders WHERE id = ?', prev.order_id)));
    }
    let amount, payload, dryRun = false;
    if (kind === 'domain') {
      const years = Number(body.years || 1);
      const names = body.domains || (body.domain ? [body.domain] : []);
      const q = await catalog.quote(names, years);
      for (const l of q.lines) {
        if (db.get("SELECT 1 FROM domains WHERE name = ? AND status <> 'pending'", l.name)) throw new HttpError(409, 'Un de ces domaines est déjà enregistré.', 'domain_taken');
        if (db.get(`SELECT 1 FROM orders WHERE kind = 'domain' AND status IN ('awaiting_payment','fulfilling') AND payload LIKE ?`, `%"name":"${l.name}"%`)) throw new HttpError(409, 'Un de ces domaines est déjà en cours d’achat.', 'domain_taken');
      }
      amount = q.amount; payload = { lines: q.lines, years }; dryRun = cfg.namesilo.dryRun;
    } else if (kind === 'subscription') {
      amount = planAmount(body.plan, body.cycle);
      const domain = body.domain ? String(body.domain).toLowerCase() : '';
      if (domain && !db.get('SELECT 1 FROM domains WHERE user_id = ? AND name = ?', user.id, domain)) throw new HttpError(400, 'Ce domaine n’est pas dans votre espace.', 'invalid_domain');
      const m = body.mailbox || {};
      payload = { plan: body.plan, cycle: body.cycle, domain, mailbox: m.local ? { local: String(m.local).toLowerCase(), name: String(m.name || m.local) } : null, renewal: !!body.renewal };
    } else {
      const years = Number(body.years || 1);
      if (!Number.isInteger(years) || years < 1 || years > cfg.maxYears) throw new HttpError(400, 'Durée invalide.', 'invalid_years');
      const d = db.get("SELECT * FROM domains WHERE user_id = ? AND name = ? AND status = 'active' AND external = 0", user.id, String(body.domain || '').toLowerCase());
      if (!d) throw new HttpError(404, 'Domaine introuvable ou non renouvelable ici.', 'not_found');
      if (db.get(`SELECT 1 FROM orders WHERE kind = 'renewal' AND status IN ('awaiting_payment','fulfilling') AND payload LIKE ?`, `%"domain":"${d.name}"%`) && !system) throw new HttpError(409, 'Un renouvellement est déjà en attente de paiement pour ce domaine.', 'duplicate');
      const q = await catalog.renewalQuote(d.name, years);
      amount = q.amount; payload = { domain: d.name, years, line: q.line }; dryRun = cfg.namesilo.dryRun;
    }

    let method = body.method;
    let methodRow = null;
    if (body.methodId) { methodRow = db.get('SELECT id, type, stripe_pm FROM payment_methods WHERE id = ? AND user_id = ?', String(body.methodId), user.id); if (methodRow && !method) method = methodRow.type; }
    if (!(methodRow && methodRow.type === 'card' && methodRow.stripe_pm && method === 'card')) methodRow = null;
    method = method || 'all';

    const oid = 'ord_' + crypto.randomBytes(8).toString('hex');
    const reference = 'FP-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const ts = new Date().toISOString();
    db.tx(() => {
      db.run(`INSERT INTO orders (id, user_id, reference, kind, status, amount, currency, payload, payment_method, dry_run, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        oid, user.id, reference, kind, 'awaiting_payment', amount, 'USD', JSON.stringify(payload), method, dryRun ? 1 : 0, ts, ts);
      if (idempotencyKey) db.run('INSERT INTO idempotency (user_id, key, order_id) VALUES (?,?,?)', user.id, idempotencyKey, oid);
    });

    let charge;
    const label = { domain: 'Freda Workspace — nom de domaine', subscription: 'Freda Workspace — offre Freda Mail', renewal: 'Freda Workspace — renouvellement de domaine' }[kind];
    try { charge = await payments.create({ amount, currency: 'USD', method, reference, userId: user.id, orderId: oid, methodId: methodRow ? methodRow.id : null, system, label }); }
    catch (e) {
      setOrder(oid, { status: 'payment_failed', error: e.message });
      if (e instanceof HttpError) throw e;
      throw new HttpError(e instanceof PaymentError ? e.status : 502, e instanceof PaymentError ? e.message : 'Le paiement a échoué.', 'payment_failed');
    }
    setOrder(oid, { charge_id: charge.providerRef || '', redirect_url: charge.redirectUrl || '', payload: { ...payload, amountHtg: charge.amountHtg, amountCents: charge.amountCents } });
    if (charge.status === 'paid') {
      const res = await fulfill(oid);
      if (res.orderStatus === 'refunded') throw new HttpError(502, 'L’enregistrement a échoué. Votre paiement est remboursé.', 'registration_failed');
      if (res.orderStatus === 'needs_attention') throw new HttpError(502, 'Un problème est survenu. Notre équipe a été alertée et vous contacte rapidement.', 'needs_attention');
      return res;
    }
    return summarize(parse(db.get('SELECT * FROM orders WHERE id = ?', oid)));
  }

  /* ---------- Confirmation du paiement ---------- */
  async function checkPayment(o) {
    let v;
    try { v = await payments.verify({ reference: o.reference, order: o }); }
    catch (e) { log('warn', 'verify_failed', { reference: o.reference }); v = null; }
    setOrder(o.id, { last_check: Date.now() });
    if (v && v.status === 'paid') {
      const p = parse(o).payload;
      if (p.amountHtg && v.amountHtg && v.amountHtg < p.amountHtg * 0.99) { alert('error', 'Montant Pay\'m inférieur à la commande', { reference: o.reference, expectedHtg: p.amountHtg, paidHtg: v.amountHtg }); setOrder(o.id, { status: 'needs_attention', error: 'Montant payé insuffisant.' }); return db.get('SELECT * FROM orders WHERE id = ?', o.id); }
      if (p.amountCents && v.amountCents && v.amountCents < p.amountCents) { alert('error', 'Montant carte inférieur à la commande', { reference: o.reference, expectedCents: p.amountCents, paidCents: v.amountCents }); setOrder(o.id, { status: 'needs_attention', error: 'Montant payé insuffisant.' }); return db.get('SELECT * FROM orders WHERE id = ?', o.id); }
      await fulfill(o.id);
      return db.get('SELECT * FROM orders WHERE id = ?', o.id);
    }
    // l'expiration n'est prononcée qu'APRÈS une vérification : un paiement tardif n'est jamais perdu
    if (v && v.status === 'failed') { setOrder(o.id, { status: 'payment_failed', error: 'Le paiement n’a pas abouti.' }); return db.get('SELECT * FROM orders WHERE id = ?', o.id); }
    if (Date.now() - new Date(o.created_at).getTime() > EXPIRE_MS) { setOrder(o.id, { status: 'expired', error: 'Paiement non reçu à temps.' }); return db.get('SELECT * FROM orders WHERE id = ?', o.id); }
    return o;
  }

  /** Confirmation déclenchée par un webhook : on ne fait JAMAIS confiance au contenu de l'événement, on revérifie chez le fournisseur. */
  async function confirmByReference(reference) {
    let o = db.get('SELECT * FROM orders WHERE reference = ?', String(reference || ''));
    if (!o) return { found: false };
    if (o.status === 'expired') { setOrder(o.id, { status: 'awaiting_payment', error: '' }); o = db.get('SELECT * FROM orders WHERE id = ?', o.id); }
    if (o.status !== 'awaiting_payment') return { found: true, status: o.status };
    o = await checkPayment(o);
    return { found: true, status: o.status };
  }

  async function status(userId, orderId) {
    let o = db.get('SELECT * FROM orders WHERE id = ? AND user_id = ?', String(orderId), userId);
    if (!o) throw new HttpError(404, 'Commande introuvable.', 'not_found');
    if (o.status === 'awaiting_payment' && Date.now() - o.last_check > 3000) o = await checkPayment(o);
    return summarize(parse(o));
  }

  /** Balayage : confirme (ou fait expirer) les commandes en attente, même si le client a fermé la page. */
  async function sweep() {
    let n = 0;
    for (const o of db.all("SELECT * FROM orders WHERE status = 'awaiting_payment' ORDER BY created_at LIMIT 100")) { await checkPayment(o); n++; }
    return { checked: n };
  }

  /* ---------- Exécution ---------- */
  async function fulfill(orderId) {
    const claimed = db.run("UPDATE orders SET status = 'fulfilling', updated_at = ? WHERE id = ? AND status IN ('awaiting_payment','paid')", new Date().toISOString(), orderId);
    if (!claimed.changes) return summarize(parse(db.get('SELECT * FROM orders WHERE id = ?', orderId)));   // déjà pris en charge
    const o = parse(db.get('SELECT * FROM orders WHERE id = ?', orderId));
    const user = db.get('SELECT * FROM users WHERE id = ?', o.user_id);
    let extra = {};
    try {
      if (o.kind === 'domain') await fulfillDomain(o, user);
      else if (o.kind === 'subscription') { const r = await fulfillSubscription(o, user); if (r.initialPassword) extra = { initialPassword: r.initialPassword }; }   // montré une seule fois, uniquement dans la réponse synchrone
      else await fulfillRenewal(o, user);
    } catch (e) {
      log('error', 'fulfill_crashed', { orderId, name: e.name, message: e.message });
      setOrder(orderId, { status: 'needs_attention', error: 'Erreur interne pendant l’exécution.' });
      alert('error', 'Commande payée mais non exécutée : à traiter à la main', { orderId, reference: o.reference, kind: o.kind });
    }
    return summarize(parse(db.get('SELECT * FROM orders WHERE id = ?', orderId)), extra);
  }

  async function refund(o, amount, reason) {
    try { await payments.refund({ reference: o.reference, amount, order: o, reason }); return true; }
    catch (e) {
      if (!(e instanceof RefundNotSupported)) log('error', 'refund_failed', { reference: o.reference });
      alert('error', 'Remboursement à effectuer MANUELLEMENT', { reference: o.reference, amount, reason, method: o.payment_method });
      return false;
    }
  }

  async function fulfillDomain(o, user) {
    const { lines, years } = o.payload;
    const done = [], failed = [];
    for (const l of lines) {
      try {
        const reg = await registrar.register({ domain: l.name, years, privacy: true, autoRenew: false, contactId: cfg.namesilo.contactId, nameservers: cfg.namesilo.nameservers });
        if (reg.contactFallback) log('warn', 'contact_fallback', { domain: l.name });
        if (reg.nameserversFallback) log('warn', 'nameservers_fallback', { domain: l.name });
        if (reg.orderAmount !== null && reg.orderAmount > l.cost * 1.1 + 0.5) alert('warn', 'Coût NameSilo supérieur au devis', { domain: l.name, expected: l.cost, charged: reg.orderAmount });
        try { await registrar.lock(l.name); } catch (e) { log('warn', 'lock_failed', { domain: l.name }); }
        const exp = new Date(); exp.setFullYear(exp.getFullYear() + years);
        const first = !db.get('SELECT 1 FROM domains WHERE user_id = ?', o.user_id);
        // auto_renew = rappels et facture de renouvellement envoyés automatiquement par Freda ; NameSilo reste en auto_renew=0
        db.run('INSERT INTO domains (id, user_id, name, status, external, dns_mode, registered_at, expires_at, auto_renew, locked, is_primary, dry_run, registrar_cost, order_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          'dom_' + crypto.randomBytes(8).toString('hex'), o.user_id, l.name, 'active', 0, 'registrar', today(), exp.toISOString().slice(0, 10), 1, 1, first ? 1 : 0, o.dry_run, reg.orderAmount, o.id, new Date().toISOString());
        activity(o.user_id, 'globe', `Domaine ${l.name} enregistré`);
        if (db.get("SELECT 1 FROM subscriptions WHERE user_id = ? AND status IN ('active','past_due')", o.user_id)) await dns.autofix(o.user_id, l.name, { quiet: true }).catch(() => log('warn', 'autofix_failed', { domain: l.name }));
        done.push(l);
      } catch (e) {
        log('error', 'register_failed', { domain: l.name, code: e.code, detail: e.detail || e.message });
        failed.push({ name: l.name, price: l.price, reason: e.detail || e.message });
      }
    }
    const failedAmount = r2(failed.reduce((s, l) => s + l.price, 0));
    let status = 'completed';
    if (failed.length) {
      const ok = await refund(o, failedAmount, 'registration_failed');
      status = ok ? (done.length ? 'partially_refunded' : 'refunded') : 'needs_attention';
    }
    const paid = r2(o.amount - (status === 'partially_refunded' || status === 'refunded' ? failedAmount : 0));
    if (done.length && status !== 'needs_attention') addInvoice(o.user_id, { label: `${done.length > 1 ? 'Domaines ' : 'Domaine '}${done.map((l) => l.name).join(', ')} (${years} ${years > 1 ? 'ans' : 'an'})`, amount: paid, method: methodLabel(o.payment_method), orderId: o.id });
    setOrder(o.id, { status, payload: { ...o.payload, done: done.map((l) => l.name), failed: failed.map((f) => ({ name: f.name, reason: f.reason })) }, error: status === 'refunded' ? 'Enregistrement impossible.' : '' });
    if (done.length) {
      mailer.trySend({ to: user.email, ...templates.receipt(user, { ...o, amount: paid }, cfg.appUrl) });
      mailer.trySend({ to: user.email, ...templates.domainRegistered(user, done.map((l) => l.name), cfg.appUrl) });
    }
  }

  async function fulfillSubscription(o, user) {
    const p = o.payload;
    const plan = cfg.plans[p.plan];
    const existing = db.get('SELECT * FROM subscriptions WHERE user_id = ?', o.user_id);
    const start = existing && existing.status !== 'cancelled' && existing.renews_at > today() && existing.plan === p.plan ? new Date(existing.renews_at) : new Date();
    const renews = new Date(start);
    if (p.cycle === 'yearly') renews.setFullYear(renews.getFullYear() + 1); else renews.setMonth(renews.getMonth() + 1);
    db.tx(() => {
      db.run(`INSERT INTO subscriptions (user_id, plan, cycle, status, renews_at, started_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, cycle = excluded.cycle, status = 'active', renews_at = excluded.renews_at, notices = 0, cancel_at_period_end = 0`,
        o.user_id, p.plan, p.cycle, 'active', renews.toISOString().slice(0, 10), today());
      addInvoice(o.user_id, { label: `${plan.name} — ${p.cycle === 'yearly' ? 'annuel' : 'mensuel'}`, amount: o.amount, method: methodLabel(o.payment_method), orderId: o.id });
      activity(o.user_id, 'mail-plus', `Offre ${plan.name} ${p.renewal ? 'renouvelée' : 'activée'}`);
    });
    const back = await mail.reactivateMailboxes(o.user_id);      // offre payée à nouveau : les boîtes suspendues rouvrent
    if (back.mailboxes.length) mailer.trySend({ to: user.email, ...templates.mailboxesReactivated(user, back.mailboxes, cfg.appUrl + '/connexion.html') });
    if (back.failed) alert('warn', 'Boîtes non réactivées (à retenter)', { userId: o.user_id, failed: back.failed });
    let initialPassword = null;
    if (p.domain && !p.renewal) {
      await dns.autofix(o.user_id, p.domain, { quiet: true }).catch(() => log('warn', 'autofix_failed', { domain: p.domain }));
      if (p.mailbox) {
        try {
          const r = await mail.createBox(o.user_id, { local: p.mailbox.local, domain: p.domain, name: p.mailbox.name });
          initialPassword = r.initialPassword;
        } catch (e) { log('warn', 'first_mailbox_failed', { message: e.message }); }
      }
    }
    setOrder(o.id, { status: 'completed', payload: { ...p, mailboxCreated: initialPassword !== null } });
    mailer.trySend({ to: user.email, ...templates.receipt(user, o, cfg.appUrl) });
    if (initialPassword) mailer.trySend({ to: user.email, subject: 'Votre première boîte mail', text: `Votre boîte ${p.mailbox.local}@${p.domain} est prête.\nMot de passe initial : ${initialPassword}\nChangez-le dès la première connexion sur ${cfg.appUrl}/connexion.html (Webmail).` });
    return { initialPassword };
  }

  async function fulfillRenewal(o, user) {
    const { domain, years } = o.payload;
    try {
      const r = await registrar.renew({ domain, years });
      if (r.orderAmount !== null && r.orderAmount > o.payload.line.cost * 1.1 + 0.5) alert('warn', 'Coût de renouvellement supérieur au devis', { domain, expected: o.payload.line.cost, charged: r.orderAmount });
    } catch (e) {
      setOrder(o.id, { status: 'needs_attention', error: 'Renouvellement NameSilo échoué : ' + (e.detail || e.message) });
      alert('error', 'Renouvellement payé mais échoué chez NameSilo', { domain, reference: o.reference });
      mailer.trySend({ to: user.email, ...templates.renewalFailed(user, domain) });
      return;
    }
    const d = db.get('SELECT * FROM domains WHERE user_id = ? AND name = ?', o.user_id, domain);
    const base = d.expires_at && d.expires_at > today() ? new Date(d.expires_at) : new Date();
    base.setFullYear(base.getFullYear() + years);
    db.tx(() => {
      db.run("UPDATE domains SET expires_at = ?, renewal_notices = 0, status = 'active' WHERE id = ?", base.toISOString().slice(0, 10), d.id);
      addInvoice(o.user_id, { label: `Renouvellement ${domain} (${years} ${years > 1 ? 'ans' : 'an'})`, amount: o.amount, method: methodLabel(o.payment_method), orderId: o.id });
      activity(o.user_id, 'refresh-cw', `Domaine ${domain} renouvelé jusqu'au ${base.toISOString().slice(0, 10)}`);
    });
    setOrder(o.id, { status: 'completed' });
    mailer.trySend({ to: user.email, ...templates.receipt(user, o, cfg.appUrl) });
  }

  return { create, status, sweep, fulfill, summarize, planAmount, confirmByReference, cardsEnabled: !!payments.cards };
}

module.exports = { createOrders };
