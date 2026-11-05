const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const PW = 'MonMotDePasse!2026';
const ORIGIN = 'http://localhost:8080';

async function withMail() {
  const t = await setup({ payments: demoPay });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } });
  const login = await (await t.api('/api/mail/login', { method: 'POST', body: { email: 'contact@neuf.com', password: PW } })).json();
  t.token = login.token;
  t.ws = (query, origin = ORIGIN) => { const m = /token=(.*)$/.exec(query); return new WebSocket(t.base.replace('http', 'ws') + '/api/mail/tunnel?' + query.replace(/&?token=.*$/, ''), ['freda.v1', ...(m && m[1] ? [m[1]] : [])], { headers: origin ? { Origin: origin } : {} }); };
  return t;
}
const status = (ws) => new Promise((resolve) => { ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); ws.terminate(); }); ws.on('open', () => { resolve(101); ws.close(); }); ws.on('error', () => {}); });

test('tunnel web : refus sans jeton valide, sans origine autorisée, avec une destination inconnue', async () => {
  const t = await withMail();
  assert.strictEqual(await status(t.ws('target=imap&token=faux')), 401);
  assert.strictEqual(await status(t.ws('target=imap&token=' + t.token, 'https://evil.example')), 403);
  assert.strictEqual(await status(t.ws('target=imap&token=' + t.token, null)), 403);
  assert.strictEqual(await status(t.ws('target=http://169.254.169.254&token=' + t.token)), 400, 'destination fixe : jamais choisie par le client');
  assert.strictEqual(await status(t.ws('target=imap&token=' + t.token)), 101);
});

test('tunnel web : les octets IMAP traversent la passerelle (accueil, AUTHENTICATE avec le mot de passe de la boîte)', async () => {
  const t = await withMail();
  const ws = t.ws('target=imap&token=' + t.token);
  let buf = '';
  const waitFor = (re) => new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error('délai : ' + buf)), 4000); const iv = setInterval(() => { if (re.test(buf)) { clearTimeout(to); clearInterval(iv); resolve(); } }, 20); });
  ws.on('message', (d) => { buf += d.toString(); });
  await new Promise((r) => ws.on('open', r));
  await waitFor(/^\* OK/m);
  ws.send(Buffer.from('a1 AUTHENTICATE PLAIN\r\n'));
  await waitFor(/^\+ /m);
  ws.send(Buffer.from(Buffer.from(`\0contact@neuf.com\0${PW}`).toString('base64') + '\r\n'));
  await waitFor(/a1 OK/);
  ws.send(Buffer.from('a2 LOGOUT\r\n'));
  await waitFor(/a2 OK/);
  ws.close();
});

test('tunnel web : un mauvais mot de passe est refusé par le serveur de messagerie (la passerelle ne le contrôle pas)', async () => {
  const t = await withMail();
  const ws = t.ws('target=imap&token=' + t.token);
  let buf = '';
  ws.on('message', (d) => { buf += d.toString(); });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 150));
  ws.send(Buffer.from('a1 AUTHENTICATE PLAIN\r\n'));
  await new Promise((r) => setTimeout(r, 150));
  ws.send(Buffer.from(Buffer.from('\0contact@neuf.com\0mauvais').toString('base64') + '\r\n'));
  await new Promise((r) => setTimeout(r, 300));
  assert.match(buf, /a1 NO/);
  ws.close();
});
