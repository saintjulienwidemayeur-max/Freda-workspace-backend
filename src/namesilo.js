/**
 * Client NameSilo (API HTTP GET uniquement, réponses JSON).
 *
 * Vérifié le 2 nov. 2026 avec https://www.namesilo.com/api-reference :
 *  - requête : GET https://www.namesilo.com/api/OPERATION?version=1&type=json&key=CLE
 *  - checkRegisterAvailability : jusqu'à 200 domaines ; available[] = { domain, price, premium (0/1), duration (années) },
 *    unavailable / invalid = { domain } (objet unique ou tableau)
 *  - registerDomain : domain, years (1-10), private (1 = WHOIS privé ; absent = non privé), auto_renew (absent = renouvellement
 *    automatique ACTIVÉ), contact_id, ns1-ns13 (2 minimum, sinon serveurs NameSilo) ; réponse { message, domain, order_amount }
 *  - codes : 300 succès ; 301 succès mais serveurs de noms NameSilo utilisés ; 302 succès mais contact par défaut utilisé ;
 *    252 (domainLock) = déjà verrouillé
 *  - getPrices : { com: { registration, transfer, renew }, ... } ; getAccountBalance : { balance }
 * Vérifié en réel (clé invalide) : statut HTTP 401 et { reply: { code: 110, detail: 'Invalid API key' } }.
 * Pas de sandbox disponible : cfg.dryRun (défaut) rend register() et lock() inoffensifs ; les lectures (disponibilité, prix, solde) sont réelles.
 * Non documenté publiquement : table complète des codes d'erreur et limites de débit.
 */
class NameSiloError extends Error {
  constructor(code, detail, operation) {
    super(`NameSilo ${operation} : ${detail || 'erreur'} (code ${code})`);
    this.name = 'NameSiloError';
    this.code = code;
    this.detail = detail;
    this.operation = operation;
  }
}

const OK_CODES = new Set([300, 301, 302]);   // 300 = succès ; 301 = serveurs de noms NameSilo utilisés ; 302 = contact par défaut utilisé
const asArray = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

function createClient(cfg, fetchImpl = fetch) {
  /** Appelle une opération. La clé API n'apparaît jamais dans les erreurs ni les journaux. */
  async function call(operation, params = {}) {
    const url = new URL(`${cfg.baseUrl.replace(/\/$/, '')}/${operation}`);
    const qs = new URLSearchParams({ version: '1', type: 'json', key: cfg.key });
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && (v !== '' || k === 'rrhost')) qs.set(k, String(v)); });   // rrhost vide = racine du domaine (paramètre présent mais vide)
    url.search = qs.toString();
    let res;
    try { res = await fetchImpl(url, { signal: AbortSignal.timeout(cfg.timeoutMs || 20000) }); }
    catch (e) { throw new NameSiloError('NETWORK', e.name === 'TimeoutError' ? 'délai dépassé' : 'réseau indisponible', operation); }
    // NameSilo répond aussi en JSON avec un statut HTTP d'erreur (ex. 401 + { reply: { code: 110, detail: 'Invalid API key' } }, vérifié en réel).
    let body = null;
    try { body = await res.json(); } catch (e) { /* corps non JSON */ }
    const reply = body && body.reply;
    if (!reply) throw new NameSiloError(res.ok ? 'PARSE' : res.status, res.ok ? 'réponse illisible' : 'HTTP ' + res.status, operation);
    const code = Number(reply.code);
    if (!OK_CODES.has(code)) throw new NameSiloError(reply.code, reply.detail, operation);
    return reply;
  }

  const client = {
    call,

    /** Disponibilité de plusieurs domaines à la fois (checkRegisterAvailability, 200 maximum). */
    async checkAvailability(domains) {
      // NameSilo vérifie les noms un par un : un gros lot dépasse le délai. Lots de 10 en parallèle, résultats fusionnés.
      if (domains.length > 10) {
        const parts = [];
        for (let i = 0; i < domains.length; i += 10) parts.push(domains.slice(i, i + 10));
        const rs = await Promise.all(parts.map((p) => client.checkAvailability(p)));
        return { available: rs.flatMap((r) => r.available), unavailable: rs.flatMap((r) => r.unavailable), invalid: rs.flatMap((r) => r.invalid) };
      }
      const reply = await call('checkRegisterAvailability', { domains: domains.join(',') });
      const available = asArray(reply.available).map((d) => (typeof d === 'string' ? { domain: d } : d))
        .map((d) => ({
          domain: String(d.domain).toLowerCase(),
          cost: d.price !== undefined ? Number(d.price) : null,
          premium: Number(d.premium) === 1 || d.premium === true || d.premium === '1',
          duration: d.duration !== undefined ? Number(d.duration) : 1,   // années couvertes par le prix
        }));
      const unavailable = asArray(reply.unavailable).map((d) => String((d && d.domain) || d).toLowerCase());
      const invalid = asArray(reply.invalid).map((d) => String((d && d.domain) || d).toLowerCase());
      return { available, unavailable, invalid };
    },

    /** Tarifs revendeur par extension (getPrices) : { '.com': { registration, renew, transfer } }. */
    async getPrices() {
      const reply = await call('getPrices');
      const out = {};
      for (const [tld, v] of Object.entries(reply)) {
        if (!v || typeof v !== 'object' || v.registration === undefined) continue;
        out['.' + tld.toLowerCase()] = { registration: Number(v.registration), renew: Number(v.renew), transfer: Number(v.transfer) };
      }
      return out;
    },

    /**
     * Enregistre un domaine (registerDomain). Débite le solde du compte revendeur.
     * Sans `auto_renew`, NameSilo active le renouvellement automatique : on envoie toujours 0 ou 1 explicitement.
     * Les serveurs de noms ne sont transmis que s'il y en a au moins 2 (règle NameSilo), jusqu'à 13.
     * Retourne { code, message, orderAmount, nameserversFallback, contactFallback }.
     */
    async register({ domain, years, privacy = true, autoRenew = false, contactId, nameservers = [] }) {
      if (cfg.dryRun) return { code: 300, message: 'DRY RUN : aucun achat effectué.', orderAmount: null, nameserversFallback: false, contactFallback: false, dryRun: true };
      const params = { domain, years, private: privacy ? 1 : 0, auto_renew: autoRenew ? 1 : 0, contact_id: contactId };
      if (nameservers.length >= 2) nameservers.slice(0, 13).forEach((ns, i) => { params['ns' + (i + 1)] = ns; });
      const r = await call('registerDomain', params);
      const code = Number(r.code);
      return { code, message: r.message || '', orderAmount: r.order_amount !== undefined ? Number(r.order_amount) : null, nameserversFallback: code === 301, contactFallback: code === 302 };
    },

    /** Verrouille le domaine ; le code 252 (« déjà verrouillé ») est un succès. */
    async lock(domain) {
      if (cfg.dryRun) return { code: 300, detail: 'dry-run' };
      try { return await call('domainLock', { domain }); }
      catch (e) { if (e instanceof NameSiloError && Number(e.code) === 252) return { code: 252, detail: e.detail }; throw e; }
    },
    /** Déverrouille le domaine ; le code 253 (« déjà déverrouillé ») est un succès. */
    async unlock(domain) {
      if (cfg.dryRun) return { code: 300, detail: 'dry-run' };
      try { return await call('domainUnlock', { domain }); }
      catch (e) { if (e instanceof NameSiloError && Number(e.code) === 253) return { code: 253, detail: e.detail }; throw e; }
    },

    /** retrieveAuthCode : NameSilo ENVOIE le code EPP par e-mail au contact administratif du domaine (il n'est pas renvoyé par l'API). */
    async requestAuthCode(domain) {
      if (cfg.dryRun) return { code: 300, dryRun: true };
      return call('retrieveAuthCode', { domain });
    },

    async info(domain) { return call('getDomainInfo', { domain }); },
    async balance() { const r = await call('getAccountBalance'); return Number(r.balance); },

    /** Renouvelle un domaine (renewDomain, 1-10 ans). Débite le solde du compte revendeur. */
    async renew({ domain, years }) {
      if (cfg.dryRun) return { code: 300, orderAmount: null, dryRun: true };
      const r = await call('renewDomain', { domain, years });
      return { code: Number(r.code), orderAmount: r.order_amount !== undefined ? Number(r.order_amount) : null };
    },

    /** Change les serveurs de noms (2 à 13). */
    async setNameservers(domain, nameservers) {
      if (cfg.dryRun) return { code: 300, dryRun: true };
      const params = { domain };
      nameservers.slice(0, 13).forEach((ns, i) => { params['ns' + (i + 1)] = ns; });
      return call('changeNameServers', params);
    },

    /* ---------- DNS hébergé chez NameSilo (domaines enregistrés via NameSilo avec leurs serveurs par défaut) ---------- */
    /** dnsListRecords : [{ id, type, host (complet), value, ttl, distance }] */
    async dnsList(domain) {
      const r = await call('dnsListRecords', { domain });
      return asArray(r.resource_record).map((x) => ({ id: String(x.record_id), type: x.type, host: String(x.host || ''), value: String(x.value || ''), ttl: Number(x.ttl), distance: Number(x.distance || 0) }));
    },
    /** dnsAddRecord : rrhost est RELATIF au domaine (pas de « .DOMAIN »), « @ » = racine -> chaîne vide. */
    async dnsAdd({ domain, type, host, value, ttl, distance }) {
      if (cfg.dryRun) return { id: 'dry_' + Math.random().toString(36).slice(2, 10), dryRun: true };
      const r = await call('dnsAddRecord', { domain, rrtype: type, rrhost: host === '@' ? '' : host, rrvalue: value, rrttl: ttl, rrdistance: type === 'MX' ? distance : undefined });
      return { id: String(r.record_id) };
    },
    /** dnsUpdateRecord : le record_id CHANGE après chaque mise à jour. */
    async dnsUpdate({ domain, id, host, value, ttl, distance, type }) {
      if (cfg.dryRun) return { id, dryRun: true };
      const r = await call('dnsUpdateRecord', { domain, rrid: id, rrhost: host === '@' ? '' : host, rrvalue: value, rrttl: ttl, rrdistance: type === 'MX' ? distance : undefined });
      return { id: String(r.record_id) };
    },
    async dnsDelete(domain, id) {
      if (cfg.dryRun) return { dryRun: true };
      return call('dnsDeleteRecord', { domain, rrid: id });
    },

    /** registrantVerificationStatus : [{ email, domains, verified }] — vérification e-mail ICANN du titulaire. */
    async registrantVerification(email) {
      const r = await call('registrantVerificationStatus', { email });
      return asArray(r.email).map((x) => ({ email: x.email_address, domains: Number(x.domains), verified: String(x.verified).toLowerCase() === 'yes' }));
    },
  };
  return client;
}

module.exports = { createClient, NameSiloError };
