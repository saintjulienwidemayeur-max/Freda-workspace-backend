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
        const item = (d) => ({ domain: d, price: 9.99, premium: state.premium.includes(d) ? 1 : 0, duration: state.longTerm.includes(d) ? 10 : 1 });
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

/** Faux Purelymail : applique les mêmes contraintes que la spécification OpenAPI (types des champs) pour détecter toute dérive de l'adaptateur. */
async function fakePurelymail(state) {
  const calls = [];
  state.domains = state.domains || [];
  state.rules = state.rules || [];
  state.users = state.users || [];
  state.verifiedTxt = state.verifiedTxt === undefined ? true : state.verifiedTxt;
  state.passwords = state.passwords || {};
  state.appPasswords = state.appPasswords || {};     // { 'user@domaine': ['mot de passe d’application'] } posés par les tests
  /** Modèle d'authentification : un utilisateur existe sous UN nom ; mot de passe principal OU mot de passe d'application de CE nom. */
  state.login = (user, pass) => (state.legacy && state.legacy[user] && !state.users.includes(user) ? state.login(state.legacy[user], pass) : false) || state.users.includes(user) && (state.passwords[user] === pass || (state.appPasswords[user] || []).includes(pass));
  /** Courrier entrant : utilisateur existant, sinon règle de routage exacte vers un utilisateur existant, sinon rejet. */
  state.deliver = (addr) => {
    if (state.users.includes(addr)) return addr;
    const [local, domain] = addr.split('@');
    const rule = state.rules.find((r) => r.domainName === domain && r.matchUser === local && !r.prefix && r.targetAddresses.some((t) => state.users.includes(t)));
    return rule ? rule.targetAddresses.find((t) => state.users.includes(t)) : null;
  };
  const bad = (res, msg) => json(res, 200, { type: 'error', code: 'invalidParameter', message: msg });
  const server = http.createServer(async (req, res) => {
    const b = await readBody(req);
    calls.push({ path: req.url, body: b, token: req.headers['purelymail-api-token'] });
    if (req.headers['purelymail-api-token'] !== 'pm-key') return json(res, 200, { type: 'error', code: 'invalidToken', message: 'bad token' });
    if (state.fail) return json(res, 500, { type: 'error', code: 'x', message: 'boom' });
    const op = req.url.replace('/api/v0/', '');
    const str = (v) => typeof v === 'string' && v.length > 0;
    switch (op) {
      case 'listDomains': return json(res, 200, { type: 'success', result: { domains: state.domains.map((name) => ({ name })) } });
      case 'getOwnershipCode': return json(res, 200, { type: 'success', result: { code: 'purelymail_ownership_proof=abc123' } });
      case 'addDomain':
        if (!str(b.domainName)) return bad(res, 'domainName');
        if (!state.verifiedTxt) return json(res, 200, { type: 'error', code: 'ownershipNotVerified', message: 'TXT missing' });
        state.domains.push(b.domainName); return json(res, 200, { type: 'success', result: {} });
      case 'createUser':
        if (!str(b.userName) || b.userName.includes('@') || !str(b.domainName) || !str(b.password)) return bad(res, 'createUser: userName = partie locale');
        if (state.domains.includes(b.domainName) && state.weakPasswords && state.weakPasswords.includes(b.password)) return json(res, 200, { type: 'error', code: 'invalidPassword', message: 'password too weak' });
        if (!state.domains.includes(b.domainName)) return json(res, 200, { type: 'error', code: 'domainNotFound', message: 'add domain first' });
        if (state.users.includes(`${b.userName}@${b.domainName}`)) return json(res, 200, { type: 'error', code: 'userExists', message: 'exists' });
        state.users.push(`${b.userName}@${b.domainName}`); state.passwords[`${b.userName}@${b.domainName}`] = b.password; return json(res, 200, { type: 'success', result: {} });
      case 'modifyUser':
        if (!str(b.userName) || !b.userName.includes('@') || (!str(b.newPassword) && !str(b.newUserName))) return bad(res, 'modifyUser: userName complet + newPassword et/ou newUserName');
        if (!state.users.includes(b.userName)) return json(res, 200, { type: 'error', code: 'userNotFound', message: 'no such user ' + b.userName });
        if (b.newUserName) {
          if (state.users.includes(b.newUserName)) return json(res, 200, { type: 'error', code: 'userExists', message: 'exists' });
          state.users[state.users.indexOf(b.userName)] = b.newUserName;
          state.legacy = state.legacy || {}; delete state.legacy[b.newUserName];
          if (state.keepOldName) state.legacy[b.userName] = b.newUserName;   // simule un serveur où le renommage ne bloque PAS l'ancienne adresse
          state.passwords[b.newUserName] = state.passwords[b.userName]; delete state.passwords[b.userName];
          state.appPasswords[b.newUserName] = state.appPasswords[b.userName] || []; delete state.appPasswords[b.userName];   // les mots de passe d'application suivent l'utilisateur
        }
        if (b.newPassword) state.passwords[b.newUserName || b.userName] = b.newPassword;
        return json(res, 200, { type: 'success', result: {} });
      case 'createAppPassword': {
        if (!str(b.userHandle) || !b.userHandle.includes('@')) return bad(res, 'createAppPassword: userHandle = adresse complète');
        if (!state.users.includes(b.userHandle)) return json(res, 200, { type: 'error', code: 'userNotFound', message: 'no such user' });
        state.appSeq = (state.appSeq || 0) + 1; const pw = `app-pw-${state.appSeq}-xxxxxxxx`;
        (state.appPasswords[b.userHandle] = state.appPasswords[b.userHandle] || []).push(pw);
        return json(res, 200, { type: 'success', result: { appPassword: pw } });
      }
      case 'deleteAppPassword': {
        const list = state.appPasswords[b.userName] || [];
        if (!str(b.userName) || !list.includes(b.appPassword)) return json(res, 200, { type: 'error', code: 'notFound', message: 'unknown app password' });
        state.appPasswords[b.userName] = list.filter((x) => x !== b.appPassword); return json(res, 200, { type: 'success', result: {} });
      }
      case 'deleteUser':
        if (!str(b.userName) || !b.userName.includes('@')) return bad(res, 'deleteUser: userName = adresse complète');
        if (!state.users.includes(b.userName)) return json(res, 200, { type: 'error', code: 'userNotFound', message: 'no such user' });
        state.users.splice(state.users.indexOf(b.userName), 1);
        return json(res, 200, { type: 'success', result: {} });
      case 'createRoutingRule':
        if (!str(b.domainName) || typeof b.prefix !== 'boolean' || !str(b.matchUser) || !Array.isArray(b.targetAddresses) || !b.targetAddresses.length) return bad(res, 'createRoutingRule: prefix booléen, matchUser chaîne');
        if (state.failRules) return json(res, 200, { type: 'error', code: 'ruleFailed', message: 'boom' });
        state.rules.push({ id: 100 + (state.ruleSeq = (state.ruleSeq || 0) + 1), domainName: b.domainName, prefix: b.prefix, matchUser: b.matchUser, targetAddresses: b.targetAddresses, catchall: !!b.catchall });
        return json(res, 200, { type: 'success', result: {} });
      case 'listRoutingRules': return json(res, 200, { type: 'success', result: { rules: state.rules } });
      case 'deleteRoutingRule':
        if (typeof b.routingRuleId !== 'number') return bad(res, 'routingRuleId numérique');
        state.rules = state.rules.filter((r) => r.id !== b.routingRuleId); return json(res, 200, { type: 'success', result: {} });
      default: return json(res, 404, { type: 'error', code: 'unknown', message: op });
    }
  });
  const url = await listen(server);
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { calls, url: url + '/api/v0' };
}

/** Faux serveur IMAP (TCP simple) : AUTHENTICATE PLAIN contrôlé par le modèle d'authentification du faux Purelymail. */
async function fakeImap(pmState) {
  const net = require('net');
  const calls = [];
  pmState.inbox = pmState.inbox || {};
  pmState.sessions = pmState.sessions || {};        // utilisateur -> nombre de connexions IMAP authentifiées ouvertes
  pmState.listeners = pmState.listeners || {};      // utilisateur -> fonctions appelées à l'arrivée d'un message (IDLE)
  const nextUid = (u) => (pmState.inbox[u] || []).reduce((m, x) => Math.max(m, x.uid || 0), 0) + 1;
  /** Dépose un message dans la boîte d'un utilisateur (livraison) et réveille les connexions IDLE. */
  pmState.addMail = (user, { subject = 'Sujet', from = 'Expéditeur <exp@example.org>', body = '', headers = '' } = {}) => {
    const box = (pmState.inbox[user] = pmState.inbox[user] || []);
    const uid = nextUid(user); box.push({ uid, subject, from, body, headers });
    (pmState.listeners[user] || []).forEach((f) => f(box.length));
    return uid;
  };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8'); sock.write('* OK IMAP ready\r\n');
    let buf = '', waitingCreds = null, authed = null, idleTag = null, listener = null;
    const drop = () => { if (listener) { pmState.listeners[authed] = (pmState.listeners[authed] || []).filter((f) => f !== listener); listener = null; } if (authed) { pmState.sessions[authed] = Math.max(0, (pmState.sessions[authed] || 1) - 1); authed = null; } };
    sock.on('error', () => {}); sock.on('close', drop);
    sock.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (pmState.imapDown) return sock.destroy();
        let m;
        if ((m = /^(\w+) AUTHENTICATE PLAIN$/i.exec(line))) { waitingCreds = m[1]; sock.write('+ \r\n'); }
        else if (waitingCreds) {
          const tag = waitingCreds; waitingCreds = null;
          const [, user, pass] = Buffer.from(line, 'base64').toString('utf8').split('\0');
          calls.push({ user, pass });
          if (pmState.login(user, pass)) { authed = user; pmState.sessions[user] = (pmState.sessions[user] || 0) + 1; sock.write(`${tag} OK Authenticated\r\n`); } else sock.write(`${tag} NO [AUTHENTICATIONFAILED] bad credentials\r\n`);
        } else if (idleTag && /^DONE$/i.test(line)) { sock.write(`${idleTag} OK IDLE terminated\r\n`); idleTag = null; pmState.listeners[authed] = (pmState.listeners[authed] || []).filter((f) => f !== listener); listener = null; }
        else if ((m = /^(\w+) SELECT/i.exec(line))) sock.write(`* ${(pmState.inbox[authed] || []).length} EXISTS\r\n* OK [UIDNEXT ${nextUid(authed)}] Predicted next UID\r\n${m[1]} OK [READ-WRITE] done\r\n`);
        else if ((m = /^(\w+) STATUS INBOX/i.exec(line))) sock.write(`* STATUS "INBOX" (UIDNEXT ${nextUid(authed)})\r\n${m[1]} OK done\r\n`);
        else if ((m = /^(\w+) IDLE$/i.exec(line))) {
          idleTag = m[1]; sock.write('+ idling\r\n');
          listener = (count) => sock.write(`* ${count} EXISTS\r\n`);
          (pmState.listeners[authed] = pmState.listeners[authed] || []).push(listener);
        }
        else if ((m = /^(\w+) UID FETCH (\d+) /i.exec(line))) {
          const msg = (pmState.inbox[authed] || []).find((x) => x.uid === Number(m[2])) || { from: '', subject: '' };
          if (/BODY\.PEEK\[TEXT\]/i.test(line)) { const b = msg.body || ''; sock.write(`* 1 FETCH (UID ${m[2]} BODY[TEXT]<0> {${Buffer.byteLength(b)}}\r\n${b})\r\n${m[1]} OK done\r\n`); continue; }
          const hdr = `From: ${msg.from}\r\nSubject: ${msg.subject}\r\n${msg.headers || ''}\r\n`;
          sock.write(`* 1 FETCH (UID ${m[2]} BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(hdr)}}\r\n${hdr})\r\n${m[1]} OK done\r\n`);
        }
        else if ((m = /^(\w+) SEARCH SUBJECT "(.*)"$/i.exec(line))) {
          const hits = (pmState.inbox[authed] || []).map((x, n) => (x.subject === m[2] ? n + 1 : 0)).filter(Boolean);
          sock.write(`${hits.length ? '* SEARCH ' + hits.join(' ') + '\r\n' : '* SEARCH\r\n'}${m[1]} OK done\r\n`);
        } else if ((m = /^(\w+) LOGOUT/i.exec(line))) { sock.write(`* BYE\r\n${m[1]} OK\r\n`); sock.end(); }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { server.closeAllConnections && server.closeAllConnections(); server.close(); });
  return { calls, port: server.address().port };
}

/** Faux SMTP (TCP simple) : AUTH PLAIN contrôlé par le modèle d'authentification, livraison via le modèle de routage du faux Purelymail. */
async function fakeSmtp(pmState) {
  const net = require('net');
  pmState.inbox = pmState.inbox || {};
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8'); sock.write('220 fake smtp\r\n');
    let buf = '', data = null, rcpt = null;
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      for (;;) {
        if (data !== null) {
          const k = buf.indexOf('\r\n.\r\n'); if (k < 0) return;
          const body = buf.slice(0, k); buf = buf.slice(k + 5); data = null;
          const subject = (/^Subject: (.*)$/m.exec(body) || [])[1] || '';
          pmState.addMail(rcpt, { subject }); sock.write('250 queued\r\n'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); let m;
        if (/^EHLO/i.test(line)) sock.write('250 fake\r\n');
        else if ((m = /^AUTH PLAIN (.+)$/i.exec(line))) { const [, u, p] = Buffer.from(m[1], 'base64').toString('utf8').split('\0'); sock.write(pmState.login(u, p) ? '235 ok\r\n' : '535 bad credentials\r\n'); }
        else if (/^MAIL FROM/i.test(line)) sock.write('250 ok\r\n');
        else if ((m = /^RCPT TO:<(.+)>$/i.exec(line))) { rcpt = pmState.deliver(m[1]); sock.write(rcpt ? '250 ok\r\n' : '550 no such user\r\n'); }
        else if (/^DATA/i.test(line)) { data = ''; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { server.close(); });
  return { port: server.address().port };
}

/** Faux Stripe : contrôle le contrat réel (Bearer, formulaire imbriqué, champs obligatoires, clés d'idempotence) et simule paiement, refus, 3-D Secure. */
async function fakeStripe(state) {
  const calls = [];
  state.sessions = {}; state.customers = 0; state.refunds = []; state.detached = []; state.pis = {};
  const readRaw = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString())); });
  const err = (res, status, e) => json(res, status, { error: { type: 'card_error', ...e } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const f = Object.fromEntries(new URLSearchParams(req.method === 'GET' ? url.search : await readRaw(req)));
    calls.push({ method: req.method, path: url.pathname, f, idem: req.headers['idempotency-key'], version: req.headers['stripe-version'] });
    if (req.headers.authorization !== 'Bearer sk_test_fake') return err(res, 401, { type: 'invalid_request_error', message: 'bad key' });
    if (req.method === 'POST' && !(url.pathname.endsWith('/detach')) && url.pathname !== '/v1/customers' && !req.headers['idempotency-key']) return err(res, 400, { type: 'invalid_request_error', message: 'idempotency key missing' });
    const p = url.pathname;
    if (p === '/v1/customers') { state.customers++; return json(res, 200, { id: 'cus_' + state.customers }); }
    if (p === '/v1/checkout/sessions' && req.method === 'POST') {
      const embedded = f.ui_mode === 'embedded_page';
      const urlsOk = embedded ? (/\{?.+/.test(f.return_url || '') && !f.success_url && !f.cancel_url && f.redirect_on_completion === 'if_required') : !!f.success_url;
      if (f.mode !== 'payment' || f['payment_method_options[card][setup_future_usage]'] !== 'off_session' || Object.keys(f).some((k) => k.startsWith('payment_method_types')) || !/^cus_/.test(f.customer || '') || !/^\d+$/.test(f['line_items[0][price_data][unit_amount]'] || '') || f['line_items[0][price_data][currency]'] !== 'usd' || !urlsOk || !f.client_reference_id) return err(res, 400, { type: 'invalid_request_error', message: 'bad checkout params' });
      const id = 'cs_' + Object.keys(state.sessions).length;
      state.sessions[id] = { id, status: 'open', payment_status: 'unpaid', amount_total: Number(f['line_items[0][price_data][unit_amount]']), ref: f.client_reference_id, customer: f.customer, ...(embedded ? { client_secret: id + '_secret_abc', ui_mode: 'embedded_page' } : { url: 'https://checkout.stripe.test/' + id }) };
      return json(res, 200, state.sessions[id]);
    }
    let m = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(p);
    if (m) { const s = state.sessions[m[1]]; if (!s) return err(res, 404, { message: 'no such session' }); return json(res, 200, s.payment_status === 'paid' ? { ...s, payment_intent: { id: 'pi_' + s.id, payment_method: state.noCard ? { id: 'pm_paypal1', type: 'paypal' } : { id: 'pm_' + (state.cardId || 'card1'), card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 } } } } : s); }
    if (p === '/v1/payment_intents' && req.method === 'POST') {
      if (f.off_session !== 'true' || f.confirm !== 'true' || !f.payment_method || !f.customer || !/^\d+$/.test(f.amount || '')) return err(res, 400, { type: 'invalid_request_error', message: 'bad pi params' });
      if (state.authRequired) return err(res, 402, { code: 'authentication_required', message: '3DS', payment_intent: { status: 'requires_action' } });
      if (state.decline) return err(res, 402, { code: 'card_declined', decline_code: 'generic_decline', message: 'declined' });
      const id = 'pi_off_' + Object.keys(state.pis).length; state.pis[id] = { id, status: 'succeeded', amount: Number(f.amount), amount_received: Number(f.amount) };
      return json(res, 200, state.pis[id]);
    }
    m = /^\/v1\/payment_intents\/(pi_\w+)$/.exec(p);
    if (m) return state.pis[m[1]] ? json(res, 200, state.pis[m[1]]) : err(res, 404, { message: 'no such pi' });
    if (p === '/v1/refunds') { if (!f.payment_intent) return err(res, 400, { type: 'invalid_request_error', message: 'payment_intent missing' }); state.refunds.push(f); return json(res, 200, { id: 're_1' }); }
    m = /^\/v1\/payment_methods\/(\w+)\/detach$/.exec(p);
    if (m) { state.detached.push(m[1]); return json(res, 200, { id: m[1] }); }
    err(res, 404, { message: 'unknown ' + p });
  });
  const url = await listen(server);
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { calls, url };
}

/** Application complète sur une base SQLite en mémoire + tous les faux services. */
async function setup(over = {}) {
  const state = { taken: ['pris.com'], premium: [], longTerm: [], balance: 500, failRegister: [], failRenew: false, registerCode: 300, lockCode: 300, dns: [], paid: new Set(), paidAmount: {}, lastAmount: {}, paymDown: false };
  const ns = await fakeNameSilo(state);
  const paym = await fakePaym(state);
  const google = await fakeGoogle();
  const pmState = { fail: false };
  const pm = await fakePurelymail(pmState);
  const imap = await fakeImap(pmState);
  const smtp = await fakeSmtp(pmState);
  const stState = {};
  const stripe = await fakeStripe(stState);
  const env = {
    NAMESILO_API_KEY: 'test-key', NAMESILO_BASE_URL: ns.url, NAMESILO_MODE: 'live', AUTH_MODE: 'demo', DB_FILE: ':memory:',
    PRICE_MARKUP_PERCENT: '30', PRICE_MIN_MARKUP: '1.5', DOMAIN_TLDS: '.com,.net,.org,.io,.xyz', JWT_SECRET: 'j'.repeat(40),
    PAYM_CLIENT_ID: 'cid', PAYM_CLIENT_SECRET: 'sec', PAYM_BASE_URL: paym.url, APP_URL: 'https://site.test', API_URL: 'https://api.test',
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', GOOGLE_TOKEN_URL: google + '/token', GOOGLE_USERINFO_URL: google + '/userinfo',
    PURELYMAIL_API_KEY: 'pm-key', PURELYMAIL_BASE_URL: pm.url, IMAP_HOST: '127.0.0.1', IMAP_PORT: String(imap.port), IMAP_SECURE: 'false',
    ...(over.stripe ? { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_BASE_URL: stripe.url } : {}), ...over.env,
  };
  const cfg = loadConfig(env);
  const cfgMailer = createMailer(cfg, () => {});
  const dnsState = { mx: {}, txt: {}, ns: {}, cname: {} };
  const resolve = over.resolve || (async (ip, domain, type) => {
    const v = (type === 'MX' ? dnsState.mx : type === 'TXT' ? dnsState.txt : type === 'CNAME' ? dnsState.cname : dnsState.ns)[domain];
    if (!v) throw new Error('NXDOMAIN');
    return v;
  });
  const refunds = [];
  const payments = over.payments === undefined ? undefined : over.payments;
  const wrapped = payments && { ...payments, refund: async (r) => { refunds.push(r); return payments.refund ? payments.refund(r) : { id: 'rf' }; } };
  const app = createApp({ cfg, log: () => {}, mailer: cfgMailer, resolve, ...(wrapped ? { payments: wrapped } : {}), ...(over.deps || {}) });
  await app.app.db.ready;
  const base = await listen(app);
  const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.as ? { 'X-Demo-User': opts.as } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined, redirect: opts.redirect || 'follow' });
  const as = (email = 'paul@example.com') => (path, opts = {}) => api(path, { ...opts, as: email });
  closers.push(() => { try { app.app.push.stop(); } catch (e) { /* déjà arrêté */ } app.closeAllConnections(); app.close(); return app.app.db.close().catch(() => {}); });
  return { api, as, user: as(), state, ns, paym, pm, pmState, imap, smtp, stripe, stState, google, cfg, app, db: app.app.db, mailer: cfgMailer, refunds, dnsState, base };
}

const closeAll = async () => { for (const c of closers.splice(0)) { try { await c(); } catch (e) { /* ignoré */ } } };
module.exports = { setup, closeAll };
