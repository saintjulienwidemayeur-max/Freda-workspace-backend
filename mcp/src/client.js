/**
 * Client minimal de l'API publique Freda Mail (/api/v1). Aucune dépendance : fetch natif (Node 20+).
 * La clé API ne figure jamais dans les erreurs ni les journaux.
 */
import { randomUUID } from 'node:crypto';

export class FredaApiError extends Error {
  constructor(status, code, message, retryAfter) { super(message); this.name = 'FredaApiError'; this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

export function createClient({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 30000 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('FREDA_API_URL invalide (ex. https://fredaworkspace.com).');
  if (!/^fmk_[A-Za-z0-9_-]{20,}$/.test(String(apiKey || ''))) throw new Error('FREDA_API_KEY manquante ou invalide : créez une clé dans le webmail (Intégrations & API).');

  async function call(method, path, { query, body, idempotencyKey } = {}) {
    const url = new URL(base + '/api/v1' + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'freda-mail-mcp/1.0' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try { res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new FredaApiError(0, 'network', e && e.name === 'TimeoutError' ? 'Le serveur Freda Mail met trop de temps à répondre.' : 'Connexion impossible au serveur Freda Mail.'); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* corps vide ou non JSON */ }
    if (!res.ok) throw new FredaApiError(res.status, data.code || 'error', data.message || `Erreur ${res.status}.`, res.headers.get('retry-after') || undefined);
    return data;
  }

  return {
    me: () => call('GET', '/me'),
    list: ({ folder, unread, limit, cursor } = {}) => call('GET', '/messages', { query: { folder, unread: unread === undefined ? undefined : String(!!unread), limit, cursor } }),
    get: (id) => call('GET', '/messages/' + encodeURIComponent(id)),
    mark: (id, unread) => call('PATCH', '/messages/' + encodeURIComponent(id), { body: { unread: !!unread } }),
    /** Un seul identifiant d'idempotence par appel d'outil : une nouvelle tentative du client ne renvoie pas le message deux fois. */
    send: (payload) => call('POST', '/messages/send', { body: payload, idempotencyKey: 'mcp-' + randomUUID() }),
  };
}
