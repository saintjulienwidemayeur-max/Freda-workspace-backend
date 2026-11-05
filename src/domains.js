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
  const sellable = (d) => !d.premium;   // NameSilo renvoie duration=10 (durée maximale) pour tous les domaines : ce n'est pas la durée minimale, on ne filtre pas dessus

  /* Extensions affichées en premier (dans cet ordre) ; les autres suivent, du moins cher au plus cher. */
  const PRIORITY = ['.com', '.net', '.org'];

  /**
   * GET /domains/search?q=[&part=main|more] — forme attendue par assets/js/api.js.
   *  part=main : le nom demandé + .com/.net/.org (un seul appel NameSilo, rapide) ;
   *  part=more : toutes les autres extensions + idées de noms (plusieurs lots, plus lent) ;
   *  sans part : tout, comme avant.
   */
  async function search(q, part) {
    if (part !== undefined && part !== null && !['main', 'more'].includes(part)) throw new HttpError(400, 'Paramètre part invalide.', 'invalid_query');
    const n = normalizeQuery(q, cfg.tlds);
    if (n.error) throw new HttpError(400, n.error, 'invalid_query');
    const book = await loadBook();
    const primary = n.tld && book[n.tld] ? n.tld : '.com';
    const all = Object.keys(book);
    if (!all.length) throw new HttpError(503, 'Tarifs indisponibles pour le moment.', 'prices_unavailable');
    const rank = (t) => (t === primary ? -2 : PRIORITY.includes(t) ? PRIORITY.indexOf(t) - 1 : 3);
    const tlds = all.slice().sort((a, b) => rank(a) - rank(b) || book[a].price - book[b].price);
    const mainTlds = [...new Set([primary, ...PRIORITY.filter((t) => book[t])])];
    const variants = ['get' + n.label, 'mon' + n.label, n.label + 'pro', n.label + 'group'].filter((l) => l.length <= 63);
    const wantTlds = part === 'main' ? mainTlds : part === 'more' ? tlds.filter((t) => !mainTlds.includes(t)) : tlds;
    const wantVariants = part === 'main' ? [] : variants;
    const candidates = [...new Set([...wantTlds.map((t) => n.label + t), ...wantVariants.map((l) => l + '.com')])];
    let avail = { available: [], unavailable: [], invalid: [] };
    if (candidates.length) {
      try { avail = await registrar.checkAvailability(candidates); }
      catch (e) { log('error', 'search_failed', { code: e.code, detail: e.detail }); throw new HttpError(502, 'La recherche est momentanément indisponible.', 'registrar_error'); }
    }
    const free = new Map(avail.available.filter(sellable).map((d) => [d.domain, d]));
    const exactName = n.label + primary, got = avail.available.find((d) => d.domain === exactName);
    if (part !== 'more') log('info', 'search_done', { part: part || 'all', exact: exactName, asked: candidates.length, available: avail.available.length, unavailable: avail.unavailable.length, invalid: avail.invalid.length, exactStatus: got ? (sellable(got) ? 'free' : 'filtered') : avail.unavailable.includes(exactName) ? 'taken' : avail.invalid.includes(exactName) ? 'invalid' : 'absent', exactPremium: got ? got.premium : undefined, exactDuration: got ? got.duration : undefined });
    const toResult = (label, tld) => {
      const p = book[tld] || book['.com'];
      return { domain: label + tld, label, tld, available: free.has(label + tld), price: p.price, compare: p.compare || undefined, renew: p.renew, included: false };
    };
    const results = wantTlds.filter((t) => t !== primary).map((t) => toResult(n.label, t));
    const suggestions = wantVariants.length ? variants.map((l) => toResult(l, '.com')).filter((r) => r.available && book['.com']).slice(0, 4) : [];
    const out = { query: n.label, unknownTld: n.unknownTld, results, suggestions };
    if (part !== 'more') out.exact = toResult(n.label, primary);
    if (part === 'main') out.partial = true;
    return out;
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

  /** GET /domains/prices — tarifs de vente par extension (même source que la recherche), pour les suggestions de saisie. */
  async function prices() {
    const book = await loadBook();
    return { tlds: Object.values(book).map((e) => ({ tld: e.tld, price: e.price, compare: e.compare || undefined, renew: e.renew })).sort((a, b) => a.price - b.price) };
  }

  /** Administration : coût NameSilo, prix de vente et marge par extension. `candidate` = aperçu de nouvelles valeurs (rien n'est enregistré). */
  async function priceTable(candidate) {
    const r2 = (x) => Math.round(x * 100) / 100;
    let book, pricing;
    try {
      const cur = await priceBook.settings();
      if (candidate && (candidate.markupPercent !== undefined || candidate.minMarkup !== undefined)) ({ book, pricing } = await priceBook.preview(candidate));
      else { book = await loadBook(); pricing = { markupPercent: cur.markupPercent, minMarkup: cur.minMarkup }; }
      return { markupPercent: pricing.markupPercent, minMarkup: pricing.minMarkup, custom: cur.custom, defaults: priceBook.defaults(), limits: { markupPercent: [0, 300], minMarkup: [0, 50] }, tlds: Object.values(book).map((e) => ({ tld: e.tld, cost: r2(e.cost), costRenew: r2(e.costRenew), price: e.price, renew: e.renew, margin: r2(e.price - e.cost), marginRenew: r2(e.renew - e.costRenew), marginPercent: Math.round((e.price - e.cost) / e.cost * 1000) / 10 })).sort((a, b) => a.cost - b.cost) };
    } catch (e) {
      if (e.code === 'invalid_pricing') throw new HttpError(400, e.message, 'invalid_pricing');
      throw e;
    }
  }

  return { search, quote, renewalQuote, prices, priceTable };
}

module.exports = { createDomainCatalog };
