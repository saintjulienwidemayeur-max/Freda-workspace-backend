const { normalizeQuery, parseDomain } = require('./domain-name');
const { totalFor } = require('./pricing');
const { HttpError } = require('./errors');

/** Recherche et devis de domaines (les prix viennent TOUJOURS d'ici). */
function createDomainCatalog({ cfg, registrar, priceBook, alert, log = () => {} }) {
  async function loadBook() {
    try { return await priceBook.load(); }
    catch (e) { log('error', 'prices_failed', { code: e.code }); throw new HttpError(502, 'Les tarifs sont momentanément indisponibles.', 'registrar_error'); }
  }
  /* Vendable : pas premium (prix imprévisible) et enregistrable pour 1 an (certaines extensions imposent une durée minimale > 1). */
  const sellable = (d) => !d.premium && (d.duration || 1) === 1;

  /** GET /domains/search?q= — forme attendue par assets/js/api.js. */
  async function search(q) {
    const n = normalizeQuery(q, cfg.tlds);
    if (n.error) throw new HttpError(400, n.error, 'invalid_query');
    const book = await loadBook();
    const primary = n.tld && book[n.tld] ? n.tld : '.com';
    const tlds = Object.keys(book);
    if (!tlds.length) throw new HttpError(503, 'Tarifs indisponibles pour le moment.', 'prices_unavailable');
    const variants = ['get' + n.label, 'mon' + n.label, n.label + 'pro', n.label + 'group'].filter((l) => l.length <= 63);
    const candidates = [...new Set([...tlds.map((t) => n.label + t), ...variants.map((l) => l + '.com')])];
    let avail;
    try { avail = await registrar.checkAvailability(candidates); }
    catch (e) { log('error', 'search_failed', { code: e.code, detail: e.detail }); throw new HttpError(502, 'La recherche est momentanément indisponible.', 'registrar_error'); }
    const free = new Map(avail.available.filter(sellable).map((d) => [d.domain, d]));
    const toResult = (label, tld) => {
      const p = book[tld] || book['.com'];
      return { domain: label + tld, label, tld, available: free.has(label + tld), price: p.price, renew: p.renew, included: false };
    };
    const exact = toResult(n.label, primary);
    const results = tlds.filter((t) => t !== primary).map((t) => toResult(n.label, t));
    const suggestions = variants.map((l) => toResult(l, '.com')).filter((r) => r.available && book['.com']).slice(0, 4);
    return { query: n.label, unknownTld: n.unknownTld, exact, results, suggestions };
  }

  /** Devis d'achat : revérifie la disponibilité, calcule le prix côté serveur, contrôle le solde du compte NameSilo. */
  async function quote(names, years) {
    if (!Number.isInteger(years) || years < 1 || years > cfg.maxYears) throw new HttpError(400, 'Durée invalide.', 'invalid_years');
    const uniq = [...new Set(names.map((d) => String(d).trim().toLowerCase()))];
    if (!uniq.length || uniq.length > 5) throw new HttpError(400, 'Choisissez entre 1 et 5 domaines.', 'invalid_domains');
    const parsed = uniq.map((d) => parseDomain(d, cfg.tlds));
    if (parsed.some((p) => !p)) throw new HttpError(400, 'Un des noms de domaine est invalide ou son extension n’est pas proposée.', 'invalid_domain');
    let avail;
    try { avail = await registrar.checkAvailability(parsed.map((p) => p.domain)); }
    catch (e) { log('error', 'availability_failed', { code: e.code, detail: e.detail }); throw new HttpError(502, 'Le registraire ne répond pas. Aucun paiement n’a été effectué.', 'registrar_error'); }
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
    try {
      const balance = await registrar.balance();
      const needed = lines.reduce((s, l) => s + l.cost, 0);
      if (balance < needed) { await alert('error', 'Solde NameSilo insuffisant', { balance, needed }); throw new HttpError(503, 'Service momentanément indisponible. Aucun paiement n’a été effectué.', 'registrar_funds'); }
    } catch (e) { if (e instanceof HttpError) throw e; /* solde illisible : registerDomain échouera proprement */ }
    return { lines, amount };
  }

  /** Prix de renouvellement (côté serveur). */
  async function renewalQuote(name, years) {
    const p = parseDomain(name, cfg.tlds);
    if (!p) throw new HttpError(400, 'Ce domaine ne peut pas être renouvelé ici.', 'invalid_domain');
    const book = await loadBook();
    const e = book[p.tld];
    if (!e) throw new HttpError(400, 'Extension non proposée : ' + p.tld, 'invalid_domain');
    return { line: { name: p.domain, tld: p.tld, price: Math.round(e.renew * years * 100) / 100, cost: Math.round(e.costRenew * years * 100) / 100 }, amount: Math.round(e.renew * years * 100) / 100 };
  }

  return { search, quote, renewalQuote };
}

module.exports = { createDomainCatalog };
