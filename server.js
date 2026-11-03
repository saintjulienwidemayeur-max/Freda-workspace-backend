const http = require('http');
const crypto = require('crypto');
const { loadConfig, assertSafe } = require('./src/config');
const { openDb } = require('./src/db');
const { HttpError } = require('./src/errors');
const { createClient } = require('./src/namesilo');
const { createPriceBook } = require('./src/pricing');
const { createPayments } = require('./src/payments');
const { createAuthenticator } = require('./src/auth');
const { createMailer } = require('./src/mailer');
const { createAlerts } = require('./src/alerts');
const { createAccounts } = require('./src/accounts');
const { createDomainCatalog } = require('./src/domains');
const { createDns } = require('./src/dns');
const { createMail } = require('./src/mail');
const { verifySignature } = require('./src/stripe');
const { createOrders } = require('./src/orders');
const { createJobs } = require('./src/jobs');
const { createWorkspace } = require('./src/workspace');
const { createDomainSettings } = require('./src/domain-settings');

const MAX_BODY = 32 * 1024;

function log(level, msg, extra = {}) { console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })); }

/** Limiteur en mémoire (par clé). Derrière un proxy, ajoutez aussi une limite à l'entrée (Cloudflare…). */
function createLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return arr.length <= max;
  };
}

function createApp(deps) {
  const cfg = deps.cfg;
  const logger = deps.log || log;
  const db = deps.db || openDb(cfg.dbFile);
  const registrar = deps.registrar || createClient(cfg.namesilo);
  const mailer = deps.mailer || createMailer(cfg, logger);
  const alert = deps.alert || createAlerts(cfg, logger);
  const payments = deps.payments || createPayments(cfg, logger, { db });
  const priceBook = createPriceBook({ registrar, cfg });
  const catalog = createDomainCatalog({ cfg, registrar, priceBook, alert, log: logger });
  const accounts = createAccounts({ cfg, db, mailer, log: logger });
  const dns = createDns({ cfg, db, registrar, log: logger, resolve: deps.resolve });
  const mail = createMail({ cfg, db, log: logger, provider: deps.mailProvider, dns });
  const orders = createOrders({ cfg, db, payments, catalog, registrar, dns, mail, mailer, alert, log: logger });
  const jobs = createJobs({ cfg, db, orders, mailer, log: logger });
  const workspace = createWorkspace({ db, accounts, dns, mail });
  const settings = createDomainSettings({ db, registrar, mailer, alert, log: logger, cfg });
  const authenticate = createAuthenticator(cfg, db);

  const L = { search: createLimiter(60, 60_000), auth: createLimiter(12, 60_000), buy: createLimiter(10, 60_000), write: createLimiter(120, 60_000), errors: createLimiter(20, 60_000) };

  /* Table de routes : [méthode, motif, gestionnaire, options]. Les segments « :nom » ne contiennent pas de « / » (les noms de domaine contiennent des points). */
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), handler, opts });

  /* ----- public ----- */
  route('GET', '/api/health', async () => ({ ok: true, registrar: cfg.namesilo.mode, payments: payments.name, mailer: cfg.mailer.provider, mailProvider: mail.providerEnabled, cards: !!payments.cards }));
  route('GET', '/api/domains/search', async (c) => { limit(L.search, c.ip, 'Trop de recherches. Réessayez dans une minute.'); return catalog.search(c.url.searchParams.get('q')); });
  route('POST', '/api/auth/signup', async (c) => { limit(L.auth, c.ip); return accounts.signup(await c.body()); });
  route('POST', '/api/auth/login', async (c) => { limit(L.auth, c.ip); return accounts.login(await c.body(), c.ip); });
  route('POST', '/api/auth/reset', async (c) => { limit(L.auth, c.ip); return accounts.requestReset((await c.body()).email); });
  route('POST', '/api/auth/reset/confirm', async (c) => { limit(L.auth, c.ip); return accounts.confirmReset(await c.body()); });
  route('POST', '/api/auth/logout', async () => ({ ok: true }));          // jetons sans état : le client oublie le jeton
  route('GET', '/api/auth/oauth/:provider', async (c, p) => ({ redirect: accounts.oauthStart(p[0], c.url.searchParams.get('next') || '') }));
  route('GET', '/api/auth/oauth/:provider/callback', async (c, p) => {
    try {
      const r = await accounts.oauthCallback(p[0], { code: c.url.searchParams.get('code') || '', state: c.url.searchParams.get('state') || '' });
      return { redirect: `${cfg.appUrl}/connexion.html#token=${r.token}${r.next ? '&next=' + encodeURIComponent(r.next) : ''}${r.isNew ? '&new=1' : ''}` };
    } catch (e) { return { redirect: `${cfg.appUrl}/connexion.html#error=${encodeURIComponent(e.code || 'oauth_failed')}` }; }
  });
  route('POST', '/api/client-errors', async (c) => {   // reçoit les erreurs JavaScript du frontend (ERROR_ENDPOINT de config.js)
    limit(L.errors, c.ip);
    const b = await c.body(4096);
    logger('warn', 'client_error', { message: String(b.message || '').slice(0, 300), page: String(b.page || '').slice(0, 120), source: String(b.source || '').slice(0, 160), line: b.line, stack: String(b.stack || '').slice(0, 800) });
    return { ok: true };
  });

  /* ----- compte ----- */
  const auth = { auth: true };
  route('GET', '/api/me', async (c) => accounts.me(c.user.id), auth);
  route('PATCH', '/api/me/company', async (c) => accounts.updateProfile(c.user.id, await c.body()), auth);
  route('PATCH', '/api/me', async (c) => accounts.updateProfile(c.user.id, await c.body()), auth);
  route('POST', '/api/me/password', async (c) => accounts.changePassword(c.user.id, await c.body()), auth);
  route('GET', '/api/workspace', async (c) => workspace(c.user.id), auth);
  route('GET', '/api/payment-methods', async (c) => ({ methods: accounts.listMethods(c.user.id) }), auth);
  route('POST', '/api/payment-methods', async (c) => ({ methods: accounts.addMethod(c.user.id, await c.body()) }), auth);
  route('PATCH', '/api/payment-methods/:id', async (c, p) => ({ methods: accounts.setDefaultMethod(c.user.id, p[0]) }), auth);
  route('DELETE', '/api/payment-methods/:id', async (c, p) => {
    const m = db.get("SELECT stripe_pm FROM payment_methods WHERE id = ? AND user_id = ? AND stripe_pm <> ''", p[0], c.user.id);
    const methods = accounts.removeMethod(c.user.id, p[0]);
    if (m && payments.stripe) await payments.stripe.detach(m.stripe_pm).catch(() => logger('warn', 'stripe_detach_failed', {}));   // la carte ne pourra plus être débitée
    return { methods };
  }, auth);

  /* ----- Stripe : webhook signé (corps BRUT requis pour la signature) ----- */
  route('POST', '/api/webhooks/stripe', async (c) => {
    if (!payments.stripe) throw new HttpError(404, 'Route introuvable.', 'not_found');
    const raw = await c.raw(256 * 1024);
    if (!verifySignature(raw, c.req.headers['stripe-signature'], cfg.payments.stripe.webhookSecret)) throw new HttpError(400, 'Signature invalide.', 'bad_signature');
    let event; try { event = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON invalide.'); }
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const obj = (event.data && event.data.object) || {};
      const ref = obj.client_reference_id || (obj.metadata && obj.metadata.reference);
      if (ref) await orders.confirmByReference(ref);   // revérifie chez Stripe ; une erreur -> 500 -> Stripe réessaie
    }
    return { received: true };
  });
  route('GET', '/api/invoices', async (c) => ({ invoices: workspace(c.user.id).invoices }), auth);

  /* ----- achats ----- */
  route('POST', '/api/checkout', async (c) => {
    limit(L.buy, c.user.id);
    const body = await c.body();
    return orders.create({ user: c.user, body, idempotencyKey: String(c.req.headers['idempotency-key'] || '').slice(0, 100) || null });
  }, auth);
  route('GET', '/api/orders/:id', async (c, p) => orders.status(c.user.id, p[0]), auth);

  /* ----- domaines ----- */
  route('GET', '/api/domains', async (c) => ({ domains: workspace(c.user.id).domains }), auth);
  route('POST', '/api/domains/connect', async (c) => { const b = await c.body(); return dns.connect(c.user.id, b.domain, b.mode); }, auth);
  route('PATCH', '/api/domains/:d', async (c, p) => settings.update(c.user.id, decodeURIComponent(p[0]), await c.body()), auth);
  route('POST', '/api/domains/:d/verify', async (c, p) => { limit(L.write, c.user.id); return dns.verify(c.user.id, decodeURIComponent(p[0])); }, auth);
  route('POST', '/api/domains/:d/auth-code', async (c, p) => { limit(L.buy, c.user.id); return settings.requestTransferCode(c.user.id, decodeURIComponent(p[0])); }, auth);

  /* ----- DNS ----- */
  route('GET', '/api/domains/:d/dns', async (c, p) => dns.list(c.user.id, decodeURIComponent(p[0])), auth);
  route('POST', '/api/domains/:d/dns', async (c, p) => { limit(L.write, c.user.id); return dns.save(c.user.id, decodeURIComponent(p[0]), await c.body()); }, auth);
  route('PATCH', '/api/domains/:d/dns/:id', async (c, p) => { limit(L.write, c.user.id); return dns.save(c.user.id, decodeURIComponent(p[0]), { ...(await c.body()), id: p[1] }); }, auth);
  route('DELETE', '/api/domains/:d/dns/:id', async (c, p) => dns.remove(c.user.id, decodeURIComponent(p[0]), p[1]), auth);
  route('POST', '/api/domains/:d/dns/autofix', async (c, p) => { limit(L.write, c.user.id); return dns.autofix(c.user.id, decodeURIComponent(p[0])); }, auth);
  route('GET', '/api/domains/:d/dns/check', async (c, p) => dns.propagation(c.user.id, decodeURIComponent(p[0])), auth);

  /* ----- Freda Mail ----- */
  route('GET', '/api/mailboxes', async (c) => ({ mailboxes: mail.listBoxes(c.user.id), aliases: mail.listAliases(c.user.id) }), auth);
  route('POST', '/api/mailboxes', async (c) => { limit(L.write, c.user.id); return mail.createBox(c.user.id, await c.body()); }, auth);
  route('DELETE', '/api/mailboxes/:id', async (c, p) => mail.removeBox(c.user.id, p[0]), auth);
  route('POST', '/api/aliases', async (c) => mail.addAlias(c.user.id, await c.body()), auth);
  route('DELETE', '/api/aliases/:id', async (c, p) => mail.removeAlias(c.user.id, p[0]), auth);

  /* ----- administration (ADMIN_TOKEN) ----- */
  const admin = { admin: true };
  route('POST', '/api/admin/jobs/run', async () => jobs.run(), admin);
  route('GET', '/api/admin/orders', async (c) => ({ orders: db.all('SELECT id, reference, user_id, kind, status, amount, error, created_at FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 100', c.url.searchParams.get('status') || 'needs_attention') }), admin);

  function limit(limiter, key, msg = 'Trop de tentatives. Réessayez dans une minute.') { if (!limiter(key)) throw new HttpError(429, msg, 'rate_limited'); }
  const tokenEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function readRaw(req, max) {
    let size = 0; const chunks = [];
    for await (const ch of req) { size += ch.length; if (size > max) throw new HttpError(413, 'Requête trop volumineuse.'); chunks.push(ch); }
    return Buffer.concat(chunks);
  }

  async function readJson(req, max = MAX_BODY) {
    let size = 0; const chunks = [];
    for await (const ch of req) { size += ch.length; if (size > max) throw new HttpError(413, 'Requête trop volumineuse.'); chunks.push(ch); }
    if (!chunks.length) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; } catch (e) { throw new HttpError(400, 'JSON invalide.'); }
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = {};
    if (origin && cfg.allowedOrigins.includes(origin)) Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors, ...headers }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') return send(204, {}, { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key', 'Access-Control-Max-Age': '600' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const url = new URL(req.url, 'http://x');
    try {
      let matched = null, params = null;
      for (const r of routes) { if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (m) { matched = r; params = m.slice(1); break; } }
      if (!matched) throw new HttpError(404, 'Route introuvable.', 'not_found');
      const ctx = { req, url, ip, body: (max) => readJson(req, max), raw: (max) => readRaw(req, max) };
      if (matched.opts.admin) {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (!cfg.adminToken || !m || !tokenEq(m[1], cfg.adminToken)) throw new HttpError(401, 'Accès administrateur requis.', 'unauthorized');
      }
      if (matched.opts.auth) ctx.user = authenticate(req);
      const out = await matched.handler(ctx, params);
      if (out && out.redirect) { res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store', ...cors }); return res.end(); }
      return send(200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) logger('error', 'request_failed', { path: url.pathname, name: e.name, code: e.code, message: status === 500 ? e.message : undefined });
      send(status, { message: status >= 500 && !(e instanceof HttpError) ? 'Erreur interne.' : e.message, code: e.code });
    }
  });
  server.app = { db, registrar, mailer, orders, jobs, dns, mail, accounts, alert };
  return server;
}

if (require.main === module) {
  const cfg = loadConfig();
  const problems = assertSafe(cfg);
  if (problems.length) { problems.forEach((p) => log('fatal', p)); process.exit(1); }
  const app = createApp({ cfg });
  app.app.jobs.start(); app.app.jobs.startSweeper();
  app.listen(cfg.port, () => log('info', 'api_started', { port: cfg.port, registrar: cfg.namesilo.mode, payments: cfg.payments.provider, mailer: cfg.mailer.provider }));
  const stop = () => { app.app.jobs.stop(); app.close(() => { app.app.db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

module.exports = { createApp };
