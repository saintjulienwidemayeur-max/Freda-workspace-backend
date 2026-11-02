const http = require('http');
const { loadConfig, assertSafe } = require('./src/config');
const { createClient } = require('./src/namesilo');
const { createPriceBook } = require('./src/pricing');
const { createStore } = require('./src/store');
const { createPayments } = require('./src/payments');
const { createAuth } = require('./src/auth');
const { createDomainService, HttpError } = require('./src/domains');

const MAX_BODY = 32 * 1024;

function log(level, msg, extra = {}) { console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })); }

/** Limiteur simple en mémoire (par IP). Derrière un proxy, placez aussi une limite à l'entrée (Cloudflare, etc.). */
function createLimiter(max, windowMs) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(ip, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return arr.length <= max;
  };
}

function createApp(deps) {
  const cfg = deps.cfg;
  const registrar = deps.registrar || createClient(cfg.namesilo);
  const store = deps.store || createStore(cfg.dataFile);
  const payments = deps.payments || createPayments(cfg);
  const priceBook = createPriceBook({ registrar, cfg });
  const domains = createDomainService({ cfg, registrar, priceBook, payments, store, log });
  const authenticate = createAuth(cfg);
  const searchLimit = createLimiter(60, 60_000), buyLimit = createLimiter(10, 60_000);

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  };
  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'Requête trop volumineuse.'); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON invalide.'); }
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = {};
    if (origin && cfg.allowedOrigins.includes(origin)) Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
    if (req.method === 'OPTIONS') return send(res, 204, {}, { ...cors, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key', 'Access-Control-Max-Age': '600' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, registrar: cfg.namesilo.mode, payments: payments.name }, cors);

      if (req.method === 'GET' && url.pathname === '/api/domains/search') {
        if (!searchLimit(ip)) throw new HttpError(429, 'Trop de recherches. Réessayez dans une minute.');
        return send(res, 200, await domains.search(url.searchParams.get('q')), cors);
      }

      if (req.method === 'POST' && url.pathname === '/api/checkout') {
        const user = authenticate(req);
        if (!buyLimit(user.id)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans une minute.');
        const body = await readJson(req);
        if (body.kind !== 'domain') throw new HttpError(400, 'Type d’achat non pris en charge ici.', 'unsupported_kind');
        const out = await domains.buy({ user, body, idempotencyKey: String(req.headers['idempotency-key'] || '').slice(0, 100) || null });
        return send(res, 200, out, cors);
      }

      if (req.method === 'GET' && url.pathname === '/api/domains') {
        const user = authenticate(req);
        return send(res, 200, { domains: store.domainsOf(user.id) }, cors);
      }

      throw new HttpError(404, 'Route introuvable.');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log('error', 'request_failed', { path: url.pathname, name: e.name, code: e.code });
      send(res, status, { message: status >= 500 && !(e instanceof HttpError) ? 'Erreur interne.' : e.message, code: e.code }, cors);
    }
  });
}

if (require.main === module) {
  const cfg = loadConfig();
  const problems = assertSafe(cfg);
  if (problems.length) { problems.forEach((p) => log('fatal', p)); process.exit(1); }
  createApp({ cfg }).listen(cfg.port, () => log('info', 'api_started', { port: cfg.port, registrar: cfg.namesilo.mode, payments: cfg.payments.provider }));
}

module.exports = { createApp };
