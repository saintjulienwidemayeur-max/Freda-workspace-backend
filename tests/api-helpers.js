/** Outils des tests de l'API publique : vrai serveur IMAP (hoodiecrow-imap) + SMTP qui dépose dans la boîte, passerelle réelle (imapflow / nodemailer). */
const hoodiecrow = require('hoodiecrow-imap');
const { startSMTPServer } = require('hoodiecrow-imap/lib/hoodiecrowSMTPServer');
const { setup } = require('./helpers');
const { issueMailboxToken } = require('../src/auth');

const PW = 'MonMotDePasse!2026';
const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const j = (r) => r.json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('délai dépassé : ' + fn); await sleep(25); } }
const raw = (id, subject, extra = '', body = 'Salut le monde') => `Message-ID: <${id}@ex.com>\r\nFrom: Marie <marie@ex.com>\r\nTo: contact@neuf.com\r\nSubject: ${subject}\r\nDate: Fri, 13 Nov 2026 10:00:00 +0000\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

/** Boîte contact@neuf.com prête : serveur IMAP + SMTP de test, application complète, session de boîte (t.token). */
async function withApi(over = {}) {
  const imapServer = hoodiecrow({
    plugins: ['IDLE', 'AUTH-PLAIN', 'SPECIAL-USE', 'UIDPLUS'],
    users: { 'contact@neuf.com': { password: 'app-pw-1-xxxxxxxx' } },   // le 1er mot de passe d'application créé par le faux Purelymail
    storage: { INBOX: { messages: [{ raw: raw('m1', 'Bonjour'), flags: [] }, { raw: raw('m2', 'Facture', '', 'Voici la facture'), flags: ['\\Seen'] }] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] } } } },
  });
  await new Promise((r) => imapServer.listen(0, r));
  const smtpServer = await new Promise((r) => { const s = startSMTPServer(0, imapServer, () => r(s)); });
  const imapPort = imapServer.server.address().port, smtpPort = smtpServer.server.address().port;
  const t = await setup({
    payments: demoPay,
    env: { IMAP_PORT: String(imapPort), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false', ...(over.env || {}) },
    deps: { gatewayTls: { rejectUnauthorized: false }, webhookAllowPrivate: true, webhookRetryDelays: [0, 20, 20], ...(over.deps || {}) },
  });
  t.imapServer = imapServer; t.smtpServer = smtpServer;
  t.close = () => { try { imapServer.close(); } catch (e) { /* déjà fermé */ } try { smtpServer.close(); } catch (e) { /* déjà fermé */ } try { t.app.app.webhooks.stop(); } catch (e) { /* déjà arrêté */ } };
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } });
  // session de boîte : jeton émis directement (la connexion par mot de passe passerait par le serveur IMAP de test, qui ne connaît que le mot de passe d'application)
  t.token = issueMailboxToken(t.cfg, await t.db.get("SELECT * FROM mailboxes WHERE local_part = 'contact'"));
  t.mb = (path, opts = {}, token = t.token) => t.api(path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  t.v1 = (path, key, opts = {}) => t.api('/api/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + key, ...(opts.headers || {}) } });
  t.newKey = async (scope = 'read_send', name = 'Agent test') => (await j(await t.mb('/api/mail/api-keys', { method: 'POST', body: { name, scope } })));
  t.inbox = () => imapServer.getMailbox('INBOX');
  t.boxId = async (local = 'contact') => (await t.db.get('SELECT id FROM mailboxes WHERE local_part = ?', local)).id;
  return t;
}

module.exports = { withApi, raw, j, sleep, waitFor, PW };
