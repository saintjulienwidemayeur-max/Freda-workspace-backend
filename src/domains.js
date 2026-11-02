const crypto = require('crypto');
const { normalizeQuery, parseDomain } = require('./domain-name');
const { totalFor } = require('./pricing');
const { PaymentError } = require('./payments');

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.name = 'HttpError'; this.status = status; this.code = code; }
}

function createDomainService({ cfg, registrar, priceBook, payments, store, log = () => {} }) {
  async function loadBook() {
    try { return await priceBook.load(); }
    catch (e) { log('error', 'prices_failed', { code: e.code }); throw new HttpError(502, 'Les tarifs sont momentanément indisponibles.', 'registrar_error'); }
  }
  /* Vendable : pas premium (prix imprévisible) et enregistrable pour 1 an (certaines extensions imposent une durée minimale > 1). */
  const sellable = (d) => !d.premium && (d.duration || 1) === 1;
  const inFlight = new Set();   // évite le double achat simultané d'un même nom

  /* ---------- Recherche (GET /domains/search?q=) : même forme que le frontend ---------- */
  async function search(q) {
    const n = normalizeQuery(q, cfg.tlds);
    if (n.error) throw new HttpError(400, n.error, 'invalid_query');
    const book = await loadBook();
    const primary = n.tld && book[n.tld] ? n.tld : '.com';
    const tlds = Object.keys(book);
    if (!tlds.length) throw new HttpError(503, 'Tarifs indisponibles pour le moment.', 'prices_unavailable');
    const variants = ['get' + n.label, 'mon' + n.label, n.label + 'pro', n.label + 'group'].filter((l) => l.length <= 63);
    const candidates = [...tlds.map((t) => n.label + t), ...variants.map((l) => l + '.com')];
    let avail;
    try { avail = await registrar.checkAvailability([...new Set(candidates)]); }
    catch (e) { log('error', 'search_failed', { code: e.code }); throw new HttpError(502, 'La recherche est momentanément indisponible.', 'registrar_error'); }
    const free = new Map(avail.available.filter(sellable).map((d) => [d.domain, d]));
    const toResult = (label, tld) => {
      const p = book[tld] || book['.com'];
      const domain = label + tld;
      return { domain, label, tld, available: free.has(domain), price: p.price, renew: p.renew, included: false };
    };
    const exact = toResult(n.label, primary);
    const results = tlds.filter((t) => t !== primary).map((t) => toResult(n.label, t));
    const suggestions = variants.map((l) => toResult(l, '.com')).filter((r) => r.available && book['.com']).slice(0, 4);
    return { query: n.label, unknownTld: n.unknownTld, exact, results, suggestions };
  }

  /* ---------- Achat (POST /checkout, kind = 'domain') ---------- */
  async function buy({ user, body, idempotencyKey }) {
    const years = Number(body.years || 1);
    if (!Number.isInteger(years) || years < 1 || years > cfg.maxYears) throw new HttpError(400, 'Durée invalide.', 'invalid_years');
    const names = [...new Set((body.domains || (body.domain ? [body.domain] : [])).map((d) => String(d).trim().toLowerCase()))];
    if (!names.length || names.length > 5) throw new HttpError(400, 'Choisissez entre 1 et 5 domaines.', 'invalid_domains');
    const parsed = names.map((d) => parseDomain(d, cfg.tlds));
    if (parsed.some((p) => !p)) throw new HttpError(400, 'Un des noms de domaine est invalide ou son extension n’est pas proposée.', 'invalid_domain');

    if (idempotencyKey) {
      const prev = store.idem(user.id, idempotencyKey);
      if (prev) return summarize(store.getOrder(prev));
    }
    if (parsed.some((p) => inFlight.has(p.domain) || store.hasDomain(p.domain))) throw new HttpError(409, 'Un de ces domaines est déjà en cours d’achat ou déjà enregistré.', 'domain_taken');
    parsed.forEach((p) => inFlight.add(p.domain));
    try { return await run(user, parsed, years, body, idempotencyKey); }
    finally { parsed.forEach((p) => inFlight.delete(p.domain)); }
  }

  async function run(user, parsed, years, body, idempotencyKey) {
    /* 1. Disponibilité et prix, revérifiés côté serveur (le montant envoyé par le navigateur est ignoré). */
    let avail;
    try { avail = await registrar.checkAvailability(parsed.map((p) => p.domain)); }
    catch (e) { log('error', 'availability_failed', { code: e.code }); throw new HttpError(502, 'Le registraire ne répond pas. Aucun paiement n’a été effectué.', 'registrar_error'); }
    const ok = new Set(avail.available.filter(sellable).map((d) => d.domain));
    const unavailable = parsed.filter((p) => !ok.has(p.domain)).map((p) => p.domain);
    if (unavailable.length) throw new HttpError(409, 'Domaine indisponible : ' + unavailable.join(', '), 'domain_unavailable');

    const book = await loadBook();
    const lines = parsed.map((p) => {
      const e = book[p.tld];
      if (!e) throw new HttpError(400, 'Extension non proposée : ' + p.tld, 'invalid_domain');
      return { name: p.domain, tld: p.tld, price: totalFor(e, years), cost: totalFor({ price: e.cost, renew: e.costRenew }, years) };
    });
    const amount = Math.round(lines.reduce((s, l) => s + l.price, 0) * 100) / 100;

    /* 2. Le solde revendeur doit couvrir le coût (sinon on ne prélève pas le client). */
    try {
      const balance = await registrar.balance();
      const needed = lines.reduce((s, l) => s + l.cost, 0);
      if (balance < needed) { log('error', 'registrar_balance_low', { balance, needed }); throw new HttpError(503, 'Service momentanément indisponible. Aucun paiement n’a été effectué.', 'registrar_funds'); }
    } catch (e) { if (e instanceof HttpError) throw e; /* solde illisible : on continue, registerDomain échouera proprement */ }

    const order = store.saveOrder({
      id: 'ord_' + crypto.randomBytes(8).toString('hex'), reference: 'FP-' + Date.now().toString().slice(-8),
      userId: user.id, kind: 'domain', years, lines, amount, currency: 'USD', status: 'pending', dryRun: cfg.namesilo.dryRun, createdAt: new Date().toISOString(),
    });
    if (idempotencyKey) store.setIdem(user.id, idempotencyKey, order.id);

    /* 3. Paiement */
    let charge;
    try { charge = await payments.charge({ amount, currency: 'USD', userId: user.id, method: body.method, methodId: body.methodId, payer: body.payer, reference: order.reference }); }
    catch (e) {
      store.saveOrder({ ...order, status: 'payment_failed', error: e.message });
      throw e instanceof PaymentError ? new HttpError(e.status, e.message, 'payment_failed') : new HttpError(502, 'Le paiement a échoué.', 'payment_failed');
    }
    store.saveOrder({ ...order, status: 'paid', chargeId: charge.id });

    /* 4. Enregistrement chez NameSilo ; remboursement de ce qui n'a pas pu être enregistré. */
    const done = [], failed = [];
    for (const l of lines) {
      try {
        const reg = await registrar.register({ domain: l.name, years, privacy: true, autoRenew: false, contactId: cfg.namesilo.contactId, nameservers: cfg.namesilo.nameservers });
        if (reg.contactFallback) log('warn', 'contact_fallback', { domain: l.name });          // code 302 : contact par défaut utilisé
        if (reg.nameserversFallback) log('warn', 'nameservers_fallback', { domain: l.name });  // code 301 : serveurs NameSilo utilisés
        if (reg.orderAmount !== null && reg.orderAmount > l.cost * 1.1 + 0.5) log('warn', 'cost_mismatch', { domain: l.name, expected: l.cost, charged: reg.orderAmount });
        l.registrarCost = reg.orderAmount;
        try { await registrar.lock(l.name); } catch (e) { log('warn', 'lock_failed', { domain: l.name, code: e.code }); }
        const exp = new Date(); exp.setFullYear(exp.getFullYear() + years);
        store.addDomain({ userId: user.id, name: l.name, orderId: order.id, registeredAt: new Date().toISOString().slice(0, 10), expiresAt: exp.toISOString().slice(0, 10), years, locked: true, autoRenew: false, registrarCost: l.registrarCost ?? null, dryRun: cfg.namesilo.dryRun });   // renouvellement géré par Freda (à implémenter) : NameSilo auto_renew=0
        done.push(l);
      } catch (e) {
        log('error', 'register_failed', { domain: l.name, code: e.code, detail: e.detail });
        failed.push({ ...l, reason: e.detail || e.message });
      }
    }
    let status = 'completed';
    if (failed.length) {
      const refundAmount = Math.round(failed.reduce((s, l) => s + l.price, 0) * 100) / 100;
      try { await payments.refund({ chargeId: charge.id, amount: refundAmount }); status = done.length ? 'partially_refunded' : 'refunded'; }
      catch (e) { status = 'needs_attention'; log('error', 'refund_failed', { orderId: order.id }); }   // à traiter à la main : alerter l'équipe
    }
    const final = store.saveOrder({ ...store.getOrder(order.id), status, registered: done.map((l) => l.name), failed: failed.map((l) => ({ name: l.name, reason: l.reason })) });
    if (!done.length) throw new HttpError(502, 'L’enregistrement a échoué. Votre paiement est remboursé.', 'registration_failed');
    return summarize(final);
  }

  function summarize(o) {
    return { status: 'succeeded', dryRun: !!o.dryRun, reference: o.reference, orderId: o.id, amount: o.amount, currency: o.currency, domains: o.registered || o.lines.map((l) => l.name), failed: o.failed || [], orderStatus: o.status };
  }

  return { search, buy, HttpError };
}

module.exports = { createDomainService, HttpError };
