/**
 * Client NameSilo (API HTTP GET, réponses JSON).
 *
 * ⚠ Écrit sans accès à https://www.namesilo.com/api-reference (réseau bloqué lors du développement) :
 * noms d'opérations, paramètres et formats de réponse sont à valider avec la référence officielle,
 * en sandbox, avant toute mise en production. Tout est isolé dans ce fichier.
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

const OK_CODES = new Set([300, 301, 302]);   // 300 = succès ; 301/302 = succès avec remarque (à vérifier dans la référence)
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
    if (!res.ok) throw new NameSiloError(res.status, 'HTTP ' + res.status, operation);
    let body;
    try { body = await res.json(); } catch (e) { throw new NameSiloError('PARSE', 'réponse illisible', operation); }
    const reply = body.reply || {};
    const code = Number(reply.code);
    if (!OK_CODES.has(code)) throw new NameSiloError(reply.code, reply.detail, operation);
    return reply;
  }

  return {
    call,

    /** Disponibilité de plusieurs domaines à la fois (checkRegisterAvailability). */
    async checkAvailability(domains) {
      const reply = await call('checkRegisterAvailability', { domains: domains.join(',') });
      const available = asArray(reply.available).map((d) => (typeof d === 'string' ? { domain: d } : d))
        .map((d) => ({ domain: String(d.domain).toLowerCase(), cost: d.price !== undefined ? Number(d.price) : null, premium: String(d.premium || '0') === '1' || d.premium === true }));
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

    /** Enregistre un domaine (registerDomain). Débite le solde du compte revendeur. */
    async register({ domain, years, privacy = true, autoRenew = false, contactId, nameservers = [] }) {
      const params = { domain, years, private: privacy ? 1 : 0, auto_renew: autoRenew ? 1 : 0, contact_id: contactId };
      nameservers.slice(0, 5).forEach((ns, i) => { params['ns' + (i + 1)] = ns; });
      return call('registerDomain', params);
    },

    async lock(domain) { return call('domainLock', { domain }); },
    async info(domain) { return call('getDomainInfo', { domain }); },
    async balance() { const r = await call('getAccountBalance'); return Number(r.balance); },
  };
}

module.exports = { createClient, NameSiloError };
