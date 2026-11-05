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
const { templates, nm } = require('./mailer');
const { cycleMonths, cycleLabel } = require('./plans');

const r2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const OPEN = ['awaiting_payment', 'fulfilling'];
const EXPIRE_MS = 2 * 3600 * 1000;

function createOrders({ vault, cfg, db, payments, catalog, registrar, dns, mail, mailer, alert, log, balance, plans }) {
  const parse = (o) => ({ ...o, payload: JSON.parse(o.payload || '{}') });
  const hooks = { afterTopup: null };   // branché par le serveur : après une recharge, payer tout de suite ce qui est dû avec le solde
  // MonCash / NatCash ne permettent aucun remboursement automatique : le remboursement est crédité sur le solde du client (instantané), sauf en mode démo
  const creditsBalance = (o) => o.payment_method === 'balance' || (['paym', 'issuing'].includes(payments.name) && o.payment_method !== 'card');

  function summarize(o, extra = {}) {
    const p = o.payload || JSON.parse(o.payload || '{}');
    const base = { orderId: o.id, reference: o.reference, kind: o.kind, amount: o.amount, currency: o.currency, orderStatus: o.status, dryRun: !!o.dry_run };
    if (o.status === 'awaiting_payment' || o.status === 'fulfilling') return { ...base, status: 'pending', redirectUrl: o.redirect_url || undefined, ...extra };
    if (['completed', 'partially_refunded'].includes(o.status)) return { ...base, status: 'succeeded', domains: p.done || (p.lines || []).map((l) => l.name), failed: p.failed || [], plan: p.plan, domain: p.domain, ...extra };
    return { ...base, status: 'failed', error: o.error || undefined, ...extra };
  }

  /** Numéro de facture unique, même avec des commandes simultanées (compteur atomique en base). */
  async function nextInvoiceId() {
    const y = new Date().getFullYear();
    const r = await db.get('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value', `invoice-${y}`);
    return `FW-${y}-${String(r.value).padStart(4, '0')}`;
  }
  async function addInvoice(userId, { label, amount, method, status = 'paid', orderId }) {
    const invId = await nextInvoiceId();
    await db.run('INSERT INTO invoices (id, user_id, date, label, amount, method, status, order_id) VALUES (?,?,?,?,?,?,?,?)', invId, userId, today(), label, amount, method, status, orderId);
    return invId;
  }
  const activity = async (userId, icon, text) => (await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, icon, text, stamp()));
  const setOrder = async (id, patch) => {
    const keys = Object.keys(patch);
    await db.run(`UPDATE orders SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (k === 'payload' ? JSON.stringify(patch[k]) : patch[k])), new Date().toISOString(), id);
  };
  /** Ajout de mois / années sans débordement de fin de mois (31 janv. + 1 mois = 28 févr., pas 3 mars). */
const addMonths = (d, n) => { const r = new Date(d); const day = r.getDate(); r.setDate(1); r.setMonth(r.getMonth() + n); r.setDate(Math.min(day, new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate())); return r; };
const methodLabel = (m) => ({ moncash: 'MonCash', natcash: 'NatCash', card: 'Carte', all: 'MonCash / NatCash', balance: 'Solde Freda Workspace' }[m] || m);

  function planAmount(planId, cycle) {
    const p = cfg.plans[planId];
    if (!p || p.free) throw new HttpError(400, 'Offre inconnue.', 'invalid_plan');   // l'offre gratuite n'est pas vendable
    const months = cycleMonths(cycle);
    if (!months) throw new HttpError(400, 'Durée de paiement inconnue (1 à 12 mois).', 'invalid_cycle');
    return r2(months === 12 ? p.monthly * cfg.pricing.yearlyMonthsBilled : p.monthly * months);   // 12 mois = 2 mois offerts
  }

  /* ---------- Création ---------- */
  async function create({ user, body, idempotencyKey, system = false }) {
    if (plans) await plans.ready;                 // prix des offres modifiés par l'administrateur : chargés avant tout calcul
    const kind = body.kind;
    if (!['domain', 'subscription', 'renewal', 'topup'].includes(kind)) throw new HttpError(400, 'Type d’achat non pris en charge.', 'unsupported_kind');
    if (idempotencyKey) {
      const prev = await db.get('SELECT order_id FROM idempotency WHERE user_id = ? AND key = ?', user.id, idempotencyKey);
      if (prev) return summarize(parse(await db.get('SELECT * FROM orders WHERE id = ?', prev.order_id)));
    }
    let amount, payload, dryRun = false;
    if (kind === 'domain') {
      const years = Number(body.years || 1);
      const names = body.domains || (body.domain ? [body.domain] : []);
      const q = await catalog.quote(names, years);
      for (const l of q.lines) {
        if ((await db.get("SELECT 1 FROM domains WHERE name = ? AND status <> 'pending'", l.name))) throw new HttpError(409, 'Un de ces domaines est déjà enregistré.', 'domain_taken');
        if ((await db.get(`SELECT 1 FROM orders WHERE kind = 'domain' AND status IN ('awaiting_payment','fulfilling') AND payload LIKE ?`, `%"name":"${l.name}"%`))) throw new HttpError(409, 'Un de ces domaines est déjà en cours d’achat.', 'domain_taken');
      }
      if (body.whoisPrivacy !== undefined && typeof body.whoisPrivacy !== 'boolean') throw new HttpError(400, 'Option de confidentialité invalide.', 'invalid_privacy');
      amount = q.amount; payload = { lines: q.lines, years, privacy: body.whoisPrivacy !== false }; dryRun = cfg.namesilo.dryRun;   // confidentialité Whois gratuite : activée par défaut, désactivable par le client
    } else if (kind === 'subscription') {
      amount = planAmount(body.plan, body.cycle);
      const domain = body.domain ? String(body.domain).toLowerCase() : '';
      if (domain && !(await db.get('SELECT 1 FROM domains WHERE user_id = ? AND name = ?', user.id, domain))) throw new HttpError(400, 'Ce domaine n’est pas dans votre espace.', 'invalid_domain');
      const m = body.mailbox || {};
      // le mot de passe choisi est validé AVANT tout paiement, puis conservé CHIFFRÉ le temps de la commande (jamais en clair, supprimé après exécution)
      const mbPw = m.local && m.password ? mail.validatePassword(m.password, String(m.local).toLowerCase()) : null;
      payload = { plan: body.plan, cycle: body.cycle, domain, mailbox: m.local ? { local: String(m.local).toLowerCase(), name: String(m.name || m.local), ...(mbPw ? { passwordEnc: vault.encrypt(mbPw) } : {}) } : null, renewal: !!body.renewal };
    } else if (kind === 'topup') {
      amount = r2(Number(body.amount));
      if (!(amount >= cfg.balance.min && amount <= cfg.balance.max)) throw new HttpError(400, `Montant de recharge invalide : entre ${cfg.balance.min} $ et ${cfg.balance.max} $.`, 'invalid_amount');
      if (body.method === 'balance') throw new HttpError(400, 'Le solde ne se recharge pas avec le solde.', 'invalid_method');
      payload = { topup: true };
    } else {
      const years = Number(body.years || 1);
      if (!Number.isInteger(years) || years < 1 || years > cfg.maxYears) throw new HttpError(400, 'Durée invalide.', 'invalid_years');
      const d = await db.get("SELECT * FROM domains WHERE user_id = ? AND name = ? AND status IN ('active','expired') AND external = 0", user.id, String(body.domain || '').toLowerCase());
      if (!d) throw new HttpError(404, 'Domaine introuvable ou non renouvelable ici.', 'not_found');
      if ((await db.get(`SELECT 1 FROM orders WHERE kind = 'renewal' AND status IN ('awaiting_payment','fulfilling') AND payload LIKE ?`, `%"domain":"${d.name}"%`)) && !system) throw new HttpError(409, 'Un renouvellement est déjà en attente de paiement pour ce domaine.', 'duplicate');
      const q = await catalog.renewalQuote(d.name, years);
      amount = q.amount; payload = { domain: d.name, years, line: q.line }; dryRun = cfg.namesilo.dryRun;
    }

    let method = body.method;
    let methodRow = null;
    if (body.methodId) { methodRow = await db.get('SELECT id, type, stripe_pm FROM payment_methods WHERE id = ? AND user_id = ?', String(body.methodId), user.id); if (methodRow && !method) method = methodRow.type; }
    if (!(methodRow && methodRow.type === 'card' && methodRow.stripe_pm && method === 'card')) methodRow = null;
    method = method || 'all';

    const oid = 'ord_' + crypto.randomBytes(8).toString('hex');
    const reference = 'FP-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const ts = new Date().toISOString();
    await db.tx(async () => {
      await db.run(`INSERT INTO orders (id, user_id, reference, kind, status, amount, currency, payload, payment_method, dry_run, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        oid, user.id, reference, kind, 'awaiting_payment', amount, 'USD', JSON.stringify(payload), method, dryRun ? 1 : 0, ts, ts);
      if (idempotencyKey) await db.run('INSERT INTO idempotency (user_id, key, order_id) VALUES (?,?,?)', user.id, idempotencyKey, oid);
    });

    let charge;
    const label = { domain: 'Freda Workspace — nom de domaine', subscription: 'Freda Workspace — offre Freda Mail', renewal: 'Freda Workspace — renouvellement de domaine', topup: 'Freda Workspace — recharge du solde' }[kind];
    if (method === 'balance') {
      // paiement avec le solde : débit atomique, uniquement s'il suffit ; aucun fournisseur de paiement n'intervient
      const ok = await balance.debit(user.id, amount, { orderId: oid, note: label.replace('Freda Workspace — ', '') });
      if (!ok) {
        const have = await balance.get(user.id);
        await setOrder(oid, { status: 'payment_failed', error: 'Solde insuffisant.' });
        throw new HttpError(402, `Solde insuffisant : il vous faut ${amount.toFixed(2)} $ et votre solde est de ${have.toFixed(2)} $. Rechargez avec MonCash ou NatCash.`, 'insufficient_balance', { needed: amount, balance: have, missing: r2(amount - have) });
      }
      charge = { status: 'paid', providerRef: 'balance' };
    } else try { charge = await payments.create({ amount, currency: 'USD', method, reference, userId: user.id, orderId: oid, methodId: methodRow ? methodRow.id : null, system, label }); }
    catch (e) {
      await setOrder(oid, { status: 'payment_failed', error: e.message });
      if (e instanceof HttpError) throw e;
      throw new HttpError(e instanceof PaymentError ? e.status : 502, e instanceof PaymentError ? e.message : 'Le paiement a échoué.', 'payment_failed');
    }
    await setOrder(oid, { charge_id: charge.providerRef || '', redirect_url: charge.redirectUrl || '', payload: { ...payload, amountHtg: charge.amountHtg, amountCents: charge.amountCents } });
    if (charge.status === 'paid') {
      const res = await fulfill(oid);
      if (res.orderStatus === 'refunded') throw new HttpError(502, 'L’enregistrement a échoué. Votre paiement est remboursé.', 'registration_failed');
      if (res.orderStatus === 'needs_attention') throw new HttpError(502, 'Un problème est survenu. Notre équipe a été alertée et vous contacte rapidement.', 'needs_attention');
      return res;
    }
    return summarize(parse(await db.get('SELECT * FROM orders WHERE id = ?', oid)), charge.embedded ? { embedded: charge.embedded } : {});   // paiement intégré : le client_secret n'est renvoyé qu'ici (et par paymentSession), jamais stocké
  }

  /** Reprise d'un paiement intégré (fenêtre fermée / page rechargée) : uniquement pour le propriétaire d'une commande encore en attente. */
  async function paymentSession(userId, orderId) {
    const o = await db.get('SELECT * FROM orders WHERE id = ? AND user_id = ?', String(orderId), userId);
    if (!o) throw new HttpError(404, 'Commande introuvable.', 'not_found');
    if (o.status !== 'awaiting_payment' || !payments.stripe) throw new HttpError(409, 'Cette commande n’attend plus de paiement.', 'not_pending');
    const embedded = await payments.stripe.resumeEmbedded(o);
    if (!embedded) throw new HttpError(409, 'Le paiement n’est plus ouvert : recommencez depuis la boutique.', 'session_closed');
    return { orderId: o.id, embedded };
  }

  /* ---------- Confirmation du paiement ---------- */
  async function checkPayment(o) {
    let v;
    try { v = await payments.verify({ reference: o.reference, order: o }); }
    catch (e) { log('warn', 'verify_failed', { reference: o.reference }); v = null; }
    await setOrder(o.id, { last_check: Date.now() });
    if (v && v.status === 'paid') {
      const p = parse(o).payload;
      // Contrôle du montant, strict et « fail closed » : un montant payé inconnu ou inférieur à l'attendu ne déclenche jamais l'exécution.
      const short = (expected, paid) => expected > 0 && !(paid >= expected);
      if (short(p.amountHtg, v.amountHtg)) { await alert('error', 'Montant HTG payé inconnu ou inférieur à la commande', { reference: o.reference, expectedHtg: p.amountHtg, paidHtg: v.amountHtg }); await setOrder(o.id, { status: 'needs_attention', error: 'Montant payé insuffisant.' }); return await db.get('SELECT * FROM orders WHERE id = ?', o.id); }
      if (short(p.amountCents, v.amountCents)) { await alert('error', 'Montant carte payé inconnu ou inférieur à la commande', { reference: o.reference, expectedCents: p.amountCents, paidCents: v.amountCents }); await setOrder(o.id, { status: 'needs_attention', error: 'Montant payé insuffisant.' }); return await db.get('SELECT * FROM orders WHERE id = ?', o.id); }
      await fulfill(o.id);
      return await db.get('SELECT * FROM orders WHERE id = ?', o.id);
    }
    // l'expiration n'est prononcée qu'APRÈS une vérification : un paiement tardif n'est jamais perdu
    if (v && v.status === 'failed') { await setOrder(o.id, { status: 'payment_failed', error: 'Le paiement n’a pas abouti.' }); return await db.get('SELECT * FROM orders WHERE id = ?', o.id); }
    if (Date.now() - new Date(o.created_at).getTime() > EXPIRE_MS) { await setOrder(o.id, { status: 'expired', error: 'Paiement non reçu à temps.' }); return await db.get('SELECT * FROM orders WHERE id = ?', o.id); }
    return o;
  }

  /** Confirmation déclenchée par un webhook : on ne fait JAMAIS confiance au contenu de l'événement, on revérifie chez le fournisseur. */
  async function confirmByReference(reference) {
    let o = await db.get('SELECT * FROM orders WHERE reference = ?', String(reference || ''));
    if (!o) return { found: false };
    if (o.status === 'expired') { await setOrder(o.id, { status: 'awaiting_payment', error: '' }); o = await db.get('SELECT * FROM orders WHERE id = ?', o.id); }
    if (o.status !== 'awaiting_payment') return { found: true, status: o.status };
    o = await checkPayment(o);
    return { found: true, status: o.status };
  }

  /** Échec définitif signalé par le fournisseur (ex. moyen de paiement différé refusé). Ne touche jamais une commande déjà exécutée. */
  async function failByReference(reference, reason) {
    const o = await db.get('SELECT * FROM orders WHERE reference = ?', String(reference || ''));
    if (!o) return { found: false };
    if (!['awaiting_payment', 'expired'].includes(o.status)) return { found: true, status: o.status };
    await setOrder(o.id, { status: 'payment_failed', error: reason || 'Le paiement n’a pas abouti.' });
    return { found: true, status: 'payment_failed' };
  }

  async function status(userId, orderId) {
    let o = await db.get('SELECT * FROM orders WHERE id = ? AND user_id = ?', String(orderId), userId);
    if (!o) throw new HttpError(404, 'Commande introuvable.', 'not_found');
    if (o.status === 'awaiting_payment' && Date.now() - o.last_check > 3000) o = await checkPayment(o);
    return summarize(parse(o));
  }

  /** Balayage : confirme (ou fait expirer) les commandes en attente, même si le client a fermé la page. */
  async function sweep() {
    let n = 0;
    for (const r of await db.all("SELECT id, payload FROM orders WHERE status NOT IN ('awaiting_payment','fulfilling') AND payload LIKE '%passwordEnc%'")) {
      const p = JSON.parse(r.payload); if (p.mailbox) delete p.mailbox.passwordEnc; await setOrder(r.id, { payload: p });   // aucun mot de passe (même chiffré) ne survit à une commande terminée
    }
    // commande restée « fulfilling » (redémarrage ou crash en pleine exécution) : jamais abandonnée en silence
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const o of await db.all("SELECT id, reference, user_id, kind, amount FROM orders WHERE status = 'fulfilling' AND updated_at < ?", cutoff)) {
      await setOrder(o.id, { status: 'needs_attention', error: 'Exécution interrompue : à vérifier.' });
      await alert('error', 'Commande bloquée en exécution (payée, non terminée)', { order: o.id, reference: o.reference, kind: o.kind, amount: o.amount });
    }
    for (const o of await db.all("SELECT * FROM orders WHERE status = 'awaiting_payment' ORDER BY created_at LIMIT 100")) { await checkPayment(o); n++; }
    return { checked: n };
  }

  /* ---------- Exécution ---------- */
  async function fulfill(orderId) {
    const claimed = await db.run("UPDATE orders SET status = 'fulfilling', updated_at = ? WHERE id = ? AND status IN ('awaiting_payment','paid')", new Date().toISOString(), orderId);
    if (!claimed.changes) return summarize(parse(await db.get('SELECT * FROM orders WHERE id = ?', orderId)));   // déjà pris en charge
    const o = parse(await db.get('SELECT * FROM orders WHERE id = ?', orderId));
    const user = await db.get('SELECT * FROM users WHERE id = ?', o.user_id);
    let extra = {};
    try {
      if (o.kind === 'domain') await fulfillDomain(o, user);
      else if (o.kind === 'topup') await fulfillTopup(o, user);
      else if (o.kind === 'subscription') { const r = await fulfillSubscription(o, user); if (r.initialPassword) extra = { initialPassword: r.initialPassword }; }   // montré une seule fois, uniquement dans la réponse synchrone
      else await fulfillRenewal(o, user);
    } catch (e) {
      log('error', 'fulfill_crashed', { orderId, name: e.name, message: e.message });
      await setOrder(orderId, { status: 'needs_attention', error: 'Erreur interne pendant l’exécution.' });
      await alert('error', 'Commande payée mais non exécutée : à traiter à la main', { orderId, reference: o.reference, kind: o.kind });
    }
    return summarize(parse(await db.get('SELECT * FROM orders WHERE id = ?', orderId)), extra);
  }

  async function refund(o, amount, reason) {
    if (creditsBalance(o)) {
      const ok = await balance.credit(o.user_id, amount, { kind: 'refund', orderId: o.id, note: `Remboursement (${reason})` });
      if (ok || (await db.get("SELECT 1 FROM balance_entries WHERE order_id = ? AND kind = 'refund'", o.id))) return true;   // déjà crédité (rejeu) = remboursé
    }
    try { await payments.refund({ reference: o.reference, amount, order: o, reason }); return true; }
    catch (e) {
      if (!(e instanceof RefundNotSupported)) log('error', 'refund_failed', { reference: o.reference });
      await alert('error', 'Remboursement à effectuer MANUELLEMENT', { reference: o.reference, amount, reason, method: o.payment_method });
      return false;
    }
  }

  /** Reçu par e-mail : pour un achat payé avec le solde, il indique aussi le solde restant. */
  async function sendReceipt(user, o, amount = o.amount) {
    if (o.payment_method === 'balance') {
      const label = { domain: 'Votre domaine', subscription: 'Votre offre Freda Mail', renewal: 'Le renouvellement de votre domaine' }[o.kind] || 'Votre achat';
      return mailer.trySend({ to: user.email, ...templates.paidFromBalance(user, { label, amount, balance: await balance.get(o.user_id), link: `${cfg.appUrl}/espace/facturation` }) });
    }
    return mailer.trySend({ to: user.email, ...templates.receipt(user, { ...o, amount }, cfg.appUrl) });
  }

  async function fulfillTopup(o, user) {
    const added = await balance.credit(o.user_id, o.amount, { kind: 'topup', orderId: o.id, note: `Recharge ${methodLabel(o.payment_method)}` });
    if (added) await addInvoice(o.user_id, { label: 'Recharge du solde', amount: o.amount, method: methodLabel(o.payment_method), orderId: o.id });
    const now = await balance.get(o.user_id);
    await activity(o.user_id, 'wallet', `Solde rechargé de ${o.amount.toFixed(2)} $ (nouveau solde : ${now.toFixed(2)} $)`);
    await setOrder(o.id, { status: 'completed' });
    if (added) await mailer.trySend({ to: user.email, ...templates.topupReceipt(user, { amount: o.amount, reference: o.reference, balance: now, link: `${cfg.appUrl}/espace/facturation` }) });
    if (added && hooks.afterTopup) { try { await hooks.afterTopup(o.user_id); } catch (e) { log('warn', 'after_topup_failed', { message: e.message }); } }   // une offre échue est payée aussitôt
  }

  async function fulfillDomain(o, user) {
    const { lines, years } = o.payload;
    const privacy = o.payload.privacy !== false;   // commandes antérieures sans ce champ : confidentialité activée
    const done = [], failed = [], doubtful = [];   // doubtful : domaine peut-être enregistré chez le registraire (délai dépassé, ou enregistrement non consigné) : jamais remboursé automatiquement
    for (const l of lines) {
      let reg;
      try {
        reg = await registrar.register({ domain: l.name, years, privacy, autoRenew: false, contactId: cfg.namesilo.contactId, nameservers: cfg.namesilo.nameservers });
      } catch (e) {
        log('error', 'register_failed', { domain: l.name, code: e.code, detail: e.detail || e.message });
        // Délai dépassé ou réponse illisible : le registraire a pu enregistrer (et débiter) quand même. On vérifie avant de rembourser.
        if (e.code === 'NETWORK' || e.code === 'PARSE' || /timeout|abort|network/i.test(String(e.message))) {
          let stillFree = false;
          try { const av = await registrar.checkAvailability([l.name]); stillFree = av.available.some((d) => d.domain === l.name); } catch (e2) { stillFree = false; }
          if (!stillFree) { doubtful.push({ name: l.name, price: l.price, reason: 'enregistrement incertain' }); continue; }
        }
        failed.push({ name: l.name, price: l.price, reason: e.detail || e.message });
        continue;
      }
      try {
        if (reg.contactFallback) log('warn', 'contact_fallback', { domain: l.name });
        if (reg.nameserversFallback) log('warn', 'nameservers_fallback', { domain: l.name });
        if (reg.orderAmount !== null && reg.orderAmount > l.cost * 1.1 + 0.5) await alert('warn', 'Coût du registraire supérieur au devis', { domain: l.name, expected: l.cost, charged: reg.orderAmount });
        let locked = 1;
        try { await registrar.lock(l.name); } catch (e) { locked = 0; log('warn', 'lock_failed', { domain: l.name }); }
        const exp = addMonths(new Date(), 12 * years);
        const first = !(await db.get('SELECT 1 FROM domains WHERE user_id = ?', o.user_id));
        const insert = () => db.run('INSERT INTO domains (id, user_id, name, status, external, dns_mode, registered_at, expires_at, auto_renew, locked, is_primary, dry_run, registrar_cost, order_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          'dom_' + crypto.randomBytes(8).toString('hex'), o.user_id, l.name, 'active', 0, 'registrar', today(), exp.toISOString().slice(0, 10), 1, locked, first ? 1 : 0, o.dry_run, reg.orderAmount, o.id, new Date().toISOString());
        // le domaine EST enregistré chez le registraire : un échec d'écriture ne doit jamais déclencher un remboursement (on réessaie, puis on alerte)
        try { await insert(); } catch (e1) { await new Promise((r) => setTimeout(r, 500)); await insert(); }
        await activity(o.user_id, 'globe', `Domaine ${l.name} enregistré`);
        if ((await db.get("SELECT 1 FROM subscriptions WHERE user_id = ? AND status IN ('active','past_due')", o.user_id))) await dns.autofix(o.user_id, l.name, { quiet: true }).catch(() => log('warn', 'autofix_failed', { domain: l.name }));
        done.push(l);
      } catch (e) {
        log('error', 'register_recorded_failed', { domain: l.name, message: e.message });
        doubtful.push({ name: l.name, price: l.price, reason: 'enregistré mais non consigné : ' + e.message });
      }
    }
    if (doubtful.length) await alert('error', 'Domaine(s) peut-être enregistré(s) sans suite : à vérifier chez le registraire', { order: o.id, reference: o.reference, domains: doubtful.map((d) => d.name) });
    const failedAmount = r2(failed.reduce((s, l) => s + l.price, 0));
    let status = 'completed';
    if (failed.length) {
      const ok = await refund(o, failedAmount, 'registration_failed');
      status = ok ? (done.length || doubtful.length ? 'partially_refunded' : 'refunded') : 'needs_attention';
    }
    if (doubtful.length) status = 'needs_attention';
    const paid = r2(o.amount - (status === 'partially_refunded' || status === 'refunded' ? failedAmount : 0));
    if (done.length && status !== 'needs_attention') await addInvoice(o.user_id, { label: `${done.length > 1 ? 'Domaines ' : 'Domaine '}${done.map((l) => l.name).join(', ')} (${years} ${years > 1 ? 'ans' : 'an'})`, amount: paid, method: methodLabel(o.payment_method), orderId: o.id });
    await setOrder(o.id, { status, payload: { ...o.payload, done: done.map((l) => l.name), failed: failed.map((f) => ({ name: f.name, reason: f.reason })) }, error: status === 'refunded' ? 'Enregistrement impossible.' : '' });
    if (done.length) {
      sendReceipt(user, o, paid);
      mailer.trySend({ to: user.email, ...templates.domainRegistered(user, done.map((l) => l.name), cfg.appUrl) });
    }
  }

  async function fulfillSubscription(o, user) {
    const p = o.payload;
    const plan = cfg.plans[p.plan];
    const existing = await db.get('SELECT * FROM subscriptions WHERE user_id = ?', o.user_id);
    const start = existing && existing.status !== 'cancelled' && existing.renews_at > today() && existing.plan === p.plan ? new Date(existing.renews_at) : new Date();
    const renews = addMonths(start, cycleMonths(p.cycle));
    await db.tx(async () => {
      await db.run(`INSERT INTO subscriptions (user_id, plan, cycle, status, renews_at, started_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, cycle = excluded.cycle, status = 'active', renews_at = excluded.renews_at, notices = 0, cancel_at_period_end = 0`,
        o.user_id, p.plan, p.cycle, 'active', renews.toISOString().slice(0, 10), today());
      await addInvoice(o.user_id, { label: `${plan.name} — ${cycleLabel(p.cycle)}`, amount: o.amount, method: methodLabel(o.payment_method), orderId: o.id });
      await activity(o.user_id, 'mail-plus', `Offre ${plan.name} ${p.renewal ? 'renouvelée' : 'activée'}`);
    });
    const back = await mail.reactivateMailboxes(o.user_id);      // offre payée à nouveau : les boîtes suspendues rouvrent
    if (back.mailboxes.length) mailer.trySend({ to: user.email, ...templates.mailboxesReactivated(user, back.mailboxes, cfg.appUrl + '/connexion') });
    if (back.failed) await alert('warn', 'Boîtes non réactivées (à retenter)', { userId: o.user_id, failed: back.failed });
    let initialPassword = null, mailboxReady = false;
    if (p.domain && !p.renewal) {
      await dns.autofix(o.user_id, p.domain, { quiet: true }).catch(() => log('warn', 'autofix_failed', { domain: p.domain }));
      if (p.mailbox) {
        try {
          const chosen = p.mailbox.passwordEnc ? vault.decrypt(p.mailbox.passwordEnc) : undefined;
          const r = await mail.createBox(o.user_id, { local: p.mailbox.local, domain: p.domain, name: p.mailbox.name, password: chosen });
          initialPassword = r.initialPassword;
          mailboxReady = r.providerReady;
        } catch (e) {
          // L'offre est payée et active, mais la boîte n'a pas pu être créée (domaine pas encore vérifié, panne Purelymail…) :
          // on prévient l'exploitant ET le client, qui crée sa boîte depuis son espace (Emails, « Ajouter une boîte »).
          log('warn', 'first_mailbox_failed', { message: e.message, code: e.code });
          await alert('warn', 'Offre payée mais première boîte non créée', { userId: o.user_id, order: o.id, address: p.mailbox.local + '@' + p.domain, reason: e.code || e.message });
          mailer.trySend({ to: user.email, subject: 'Votre offre est active — finalisez votre boîte mail', text: `Votre offre est bien activée, mais la boîte ${p.mailbox.local}@${p.domain} n'a pas pu être créée automatiquement (${e.code === 'domain_pending_verification' ? 'votre domaine n’est pas encore vérifié : les enregistrements DNS peuvent mettre un peu de temps à se propager' : 'incident temporaire'}).\nVous n'avez rien à repayer : ouvrez votre espace, rubrique Emails, puis « Ajouter une boîte » (${cfg.appUrl}/espace/emails).\nSi le problème persiste, répondez à ce message.` });
        }
      }
    }
    const clean = { ...p, mailbox: p.mailbox ? { local: p.mailbox.local, name: p.mailbox.name } : null };   // le mot de passe chiffré est supprimé dès que la boîte existe
    await setOrder(o.id, { status: 'completed', payload: { ...clean, mailboxCreated: mailboxReady } });
    await sendReceipt(user, o);
    if (mailboxReady) mailer.trySend({ to: user.email, subject: 'Votre première boîte mail', text: initialPassword
      ? `Bonjour ${nm(user)},\n\nVotre boîte ${p.mailbox.local}@${p.domain} est prête.\nMot de passe initial : ${initialPassword}\n\nChangez-le dès la première connexion.`
      : `Bonjour ${nm(user)},\n\nVotre boîte ${p.mailbox.local}@${p.domain} est prête.\nOuvrez l'application Freda Mail et connectez-vous avec cette adresse et le mot de passe que vous avez choisi (il n'est jamais envoyé par e-mail).` });
    return { initialPassword };
  }

  async function fulfillRenewal(o, user) {
    const { domain, years } = o.payload;
    try {
      const r = await registrar.renew({ domain, years });
      if (r.orderAmount !== null && r.orderAmount > o.payload.line.cost * 1.1 + 0.5) await alert('warn', 'Coût de renouvellement supérieur au devis', { domain, expected: o.payload.line.cost, charged: r.orderAmount });
    } catch (e) {
      if (o.payment_method === 'balance' && await refund(o, o.amount, 'renewal_failed')) {   // payé avec le solde : recrédité tout de suite
        await setOrder(o.id, { status: 'refunded', error: 'Renouvellement impossible : solde recrédité.' });
        await alert('warn', 'Renouvellement échoué chez NameSilo : solde du client recrédité', { domain, reference: o.reference });
        return;
      }
      await setOrder(o.id, { status: 'needs_attention', error: 'Renouvellement NameSilo échoué : ' + (e.detail || e.message) });
      await alert('error', 'Renouvellement payé mais échoué chez NameSilo', { domain, reference: o.reference });
      mailer.trySend({ to: user.email, ...templates.renewalFailed(user, domain) });
      return;
    }
    const d = await db.get('SELECT * FROM domains WHERE user_id = ? AND name = ?', o.user_id, domain);
    // le registraire prolonge à partir de la date d'expiration d'origine, même en période de grâce
    const base = addMonths(d.expires_at ? new Date(d.expires_at) : new Date(), 12 * years);
    await db.tx(async () => {
      await db.run("UPDATE domains SET expires_at = ?, renewal_notices = 0, status = 'active' WHERE id = ?", base.toISOString().slice(0, 10), d.id);
      await addInvoice(o.user_id, { label: `Renouvellement ${domain} (${years} ${years > 1 ? 'ans' : 'an'})`, amount: o.amount, method: methodLabel(o.payment_method), orderId: o.id });
      await activity(o.user_id, 'refresh-cw', `Domaine ${domain} renouvelé jusqu'au ${base.toISOString().slice(0, 10)}`);
    });
    await setOrder(o.id, { status: 'completed' });
    await sendReceipt(user, o);
  }

  async function renewalAmount(userId, domain, years = 1) {
    const d = await db.get("SELECT name FROM domains WHERE user_id = ? AND name = ? AND status IN ('active','expired') AND external = 0", userId, String(domain).toLowerCase());
    return d ? (await catalog.renewalQuote(d.name, years)).amount : null;
  }

  return { create, status, sweep, fulfill, summarize, planAmount, renewalAmount, hooks, confirmByReference, failByReference, paymentSession, cardsEnabled: !!payments.cards };
}

module.exports = { createOrders };
