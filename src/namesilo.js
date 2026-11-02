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
 * Vérifié en réel (clé invalide) : https://www.namesilo.com/api/ et https://sandbox.namesilo.com/api/ répondent avec la même enveloppe,
 * statut HTTP 401 et { reply: { code: 110, detail: 'Invalid API key' } }. Les identifiants sandbox se demandent à NameSilo.
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
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
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

  return {
    call,

    /** Disponibilité de plusieurs domaines à la fois (checkRegisterAvailability, 200 maximum). */
    async checkAvailability(domains) {
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
      const params = { domain, years, private: privacy ? 1 : 0, auto_renew: autoRenew ? 1 : 0, contact_id: contactId };
      if (nameservers.length >= 2) nameservers.slice(0, 13).forEach((ns, i) => { params['ns' + (i + 1)] = ns; });
      const r = await call('registerDomain', params);
      const code = Number(r.code);
      return { code, message: r.message || '', orderAmount: r.order_amount !== undefined ? Number(r.order_amount) : null, nameserversFallback: code === 301, contactFallback: code === 302 };
    },

    /** Verrouille le domaine ; le code 252 (« déjà verrouillé ») est un succès. */
    async lock(domain) {
      try { return await call('domainLock', { domain }); }
      catch (e) { if (e instanceof NameSiloError && Number(e.code) === 252) return { code: 252, detail: e.detail }; throw e; }
    },
    async info(domain) { return call('getDomainInfo', { domain }); },
    async balance() { const r = await call('getAccountBalance'); return Number(r.balance); },
  };
}

module.exports = { createClient, NameSiloError };
