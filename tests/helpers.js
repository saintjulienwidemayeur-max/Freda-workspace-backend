const http = require('http');
const { loadConfig } = require('../src/config');
const { createApp } = require('../server');
const { createMailer } = require('../src/mailer');

const closers = [];
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));
const json = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); const t = Buffer.concat(c).toString(); try { return JSON.parse(t); } catch (e) { return Object.fromEntries(new URLSearchParams(t)); } };

/** Faux NameSilo : mêmes enveloppes et formes que la référence officielle ({ request, reply: { code, detail, … } }). */
async function fakeNameSilo(state) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const op = u.pathname.split('/').pop();
    const q = Object.fromEntries(u.searchParams);
    calls.push({ op, q });
    const reply = (r, status = 200) => json(res, status, { request: { operation: op }, reply: r });
    if (q.key !== 'test-key') return reply({ code: 110, detail: 'Invalid API key' }, 401);
    switch (op) {
      case 'getPrices': return reply({ code: 300, detail: 'success', com: { registration: 10, transfer: 10, renew: 12 }, net: { registration: 11, transfer: 11, renew: 13 }, org: { registration: 9, transfer: 9, renew: 11 }, io: { registration: 30, transfer: 30, renew: 40 } });
      case 'checkRegisterAvailability': {
        const ds = q.domains.split(',');
        const free = ds.filter((d) => !state.taken.includes(d));
        const taken = ds.filter((d) => state.taken.includes(d)).map((d) => ({ domain: d }));
        const item = (d) => ({ domain: d, price: 9.99, premium: state.premium.includes(d) ? 1 : 0, duration: state.longTerm.includes(d) ? 2 : 1 });
        const out = { code: 300, detail: 'success', available: free.map(item) };
        if (taken.length) out.unavailable = taken.length === 1 ? taken[0] : taken;
        return reply(out);
      }
      case 'getAccountBalance': return reply({ code: 300, detail: 'success', balance: state.balance });
      case 'registerDomain': return state.failRegister.includes(q.domain) ? reply({ code: 261, detail: 'Registry error' }) : reply({ code: state.registerCode, detail: 'success', message: 'Your domain registration was successfully processed.', domain: q.domain, order_amount: 10 });
      case 'renewDomain': return state.failRenew ? reply({ code: 280, detail: 'Renew error' }) : reply({ code: 300, detail: 'success', message: 'Your domain renewal was successfully processed.', domain: q.domain, order_amount: 12 });
      case 'domainLock': return state.lockCode === 252 ? reply({ code: 252, detail: 'Domain is already Locked - No update made.' }) : reply({ code: 300, detail: 'success' });
      case 'domainUnlock': return reply({ code: 300, detail: 'success' });
      case 'retrieveAuthCode': return reply({ code: 300, detail: 'success' });
      case 'dnsAddRecord': { const id = 'r' + (state.dnsSeq = (state.dnsSeq || 0) + 1); state.dns.push({ id, ...q }); return reply({ code: 300, detail: 'success', record_id: id }); }
      case 'dnsUpdateRecord': { const r = state.dns.find((x) => x.id === q.rrid); if (!r) return reply({ code: 280, detail: 'no such record' }); r.id = 'r' + (state.dnsSeq = state.dnsSeq + 1); Object.assign(r, q, { id: r.id }); return reply({ code: 300, detail: 'success', record_id: r.id }); }
      case 'dnsDeleteRecord': state.dns = state.dns.filter((x) => x.id !== q.rrid); return reply({ code: 300, detail: 'success' });
      default: return reply({ code: 210, detail: 'unknown operation ' + op });
    }
  });
  const url = await listen(server);
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { calls, url: url + '/api' };
}

/** Faux Pay'm : /api/paiement-marchand puis /api/paiement-verify (trans_status « ok » / « no »). */
async function fakePaym(state) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const b = await readBody(req);
    calls.push({ path: req.url, body: b });
    if (req.url === '/api/paiement-marchand') return state.paymDown ? json(res, 500, { message: 'down' }) : json(res, 200, { status: true, message: 'ok', url: 'https://pay.test/pay/' + b.refference_id, transaction_id: 'tx_' + b.refference_id });
    if (req.url === '/api/paiement-verify') return json(res, 200, { status: true, trans_status: state.paid.has(b.refference_id) ? 'ok' : 'no', montant: state.paidAmount[b.refference_id] ?? state.lastAmount[b.refference_id] ?? 0, id_transaction: 'tx' });
    json(res, 404, {});
  });
  const origCreate = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    if (req.url === '/api/paiement-marchand') { const copy = []; for await (const c of req) copy.push(c); const b = JSON.parse(Buffer.concat(copy).toString()); state.lastAmount[b.refference_id] = b.montant; calls.push({ path: req.url, body: b }); return state.paymDown ? json(res, 500, { message: 'down' }) : json(res, 200, { status: true, message: 'ok', url: 'https://pay.test/pay/' + b.refference_id, transaction_id: 'tx_' + b.refference_id }); }
    return origCreate(req, res);
  });
  const url = await listen(server);
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { calls, url };
}

async function fakeGoogle() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/token') { const b = await readBody(req); return b.code === 'good' ? json(res, 200, { access_token: 'at' }) : json(res, 400, { error: 'bad' }); }
    if (req.url === '/userinfo') return json(res, 200, { sub: 'g-123', email: 'Google.User@Example.com', email_verified: true, name: 'Google User' });
    json(res, 404, {});
  });
  const url = await listen(server);
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return url;
}

async function fakePurelymail(state) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const b = await readBody(req);
    calls.push({ path: req.url, body: b, token: req.headers['purelymail-api-token'] });
    if (state.fail) return json(res, 500, { type: 'error', code: 'x', message: 'boom' });
    if (req.url.endsWith('/createRoutingRule')) return json(res, 200, { type: 'success', result: { id: 77 } });
    json(res, 200, { type: 'success', result: {} });
  });
  const url = await listen(server);
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { calls, url: url + '/api/v0' };
}

/** Application complète sur une base SQLite en mémoire + tous les faux services. */
async function setup(over = {}) {
  const state = { taken: ['pris.com'], premium: [], longTerm: [], balance: 500, failRegister: [], failRenew: false, registerCode: 300, lockCode: 300, dns: [], paid: new Set(), paidAmount: {}, lastAmount: {}, paymDown: false };
  const ns = await fakeNameSilo(state);
  const paym = await fakePaym(state);
  const google = await fakeGoogle();
  const pmState = { fail: false };
  const pm = await fakePurelymail(pmState);
  const env = {
    NAMESILO_API_KEY: 'test-key', NAMESILO_BASE_URL: ns.url, NAMESILO_MODE: 'live', AUTH_MODE: 'demo', DB_FILE: ':memory:',
    PRICE_MARKUP_PERCENT: '30', PRICE_MIN_MARKUP: '1.5', DOMAIN_TLDS: '.com,.net,.org,.io,.xyz', JWT_SECRET: 'j'.repeat(40),
    PAYM_CLIENT_ID: 'cid', PAYM_CLIENT_SECRET: 'sec', PAYM_BASE_URL: paym.url, APP_URL: 'https://site.test', API_URL: 'https://api.test',
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', GOOGLE_TOKEN_URL: google + '/token', GOOGLE_USERINFO_URL: google + '/userinfo',
    PURELYMAIL_API_KEY: 'pm-key', PURELYMAIL_BASE_URL: pm.url, ...over.env,
  };
  const cfg = loadConfig(env);
  const cfgMailer = createMailer(cfg, () => {});
  const dnsState = { mx: {}, txt: {}, ns: {} };
  const resolve = over.resolve || (async (ip, domain, type) => {
    const v = (type === 'MX' ? dnsState.mx : type === 'TXT' ? dnsState.txt : dnsState.ns)[domain];
    if (!v) throw new Error('NXDOMAIN');
    return v;
  });
  const refunds = [];
  const payments = over.payments === undefined ? undefined : over.payments;
  const wrapped = payments && { ...payments, refund: async (r) => { refunds.push(r); return payments.refund ? payments.refund(r) : { id: 'rf' }; } };
  const app = createApp({ cfg, log: () => {}, mailer: cfgMailer, resolve, ...(wrapped ? { payments: wrapped } : {}), ...(over.deps || {}) });
  const base = await listen(app);
  const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.as ? { 'X-Demo-User': opts.as } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined, redirect: opts.redirect || 'follow' });
  const as = (email = 'paul@example.com') => (path, opts = {}) => api(path, { ...opts, as: email });
  closers.push(() => { app.closeAllConnections(); app.close(); try { app.app.db.close(); } catch (e) { /* déjà fermée */ } });
  return { api, as, user: as(), state, ns, paym, pm, pmState, google, cfg, app, db: app.app.db, mailer: cfgMailer, refunds, dnsState, base };
}

const closeAll = () => closers.splice(0).forEach((c) => { try { c(); } catch (e) { /* ignoré */ } });
module.exports = { setup, closeAll };
