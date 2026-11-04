const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http2 = require('node:http2');
const { setup, closeAll } = require('./helpers');
const { createApns, createFcm } = require('../src/push-senders');
const { loadConfig, assertSafe } = require('../src/config');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const j = (r) => r.json();
const PW = 'MonMotDePasse!2026';
const IOS = 'a'.repeat(64), ANDROID = 'fcm-token:' + 'b'.repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('délai dépassé : ' + fn); await sleep(15); } }

async function withPush(over = {}) {
  const sent = [];
  const mk = (platform, behave) => ({ async send(token, msg) { sent.push({ platform, token, msg }); return behave(token, msg); } });
  const state = { iosResult: { ok: true }, androidResult: { ok: true } };
  const t = await setup({
    payments: demoPay, env: over.env,
    deps: { pushDebounceMs: over.debounce ?? 30, pushSenders: over.senders || { ios: mk('ios', () => state.iosResult), android: mk('android', () => state.androidResult) } },
  });
  t.sent = sent; t.sender = state;
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } });
  t.login = async (local = 'contact', password = PW) => { const r = await t.api('/api/mail/login', { method: 'POST', body: { email: `${local}@neuf.com`, password } }); return r.status === 200 ? (await j(r)).token : null; };
  t.token = await t.login();
  t.mb = (path, opts = {}, token = t.token) => t.api(path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  t.reg = (body, token) => t.mb('/api/mail/push', { method: 'POST', body }, token);
  t.push = t.app.app.push;
  t.boxId = async (local = 'contact') => (await t.db.get('SELECT id FROM mailboxes WHERE local_part = ?', local)).id;
  t.ready = async (local = 'contact') => { const id = await t.boxId(local); return (await waitFor(() => t.push.watchers().get(id))).w.ready; };
  return t;
}
const U = 'contact@neuf.com';

test('session de boîte : le jeton renvoyé par /api/mail/login n’ouvre QUE les routes /api/mail/push ; jeton de compte, absent ou falsifié refusés', async () => {
  const t = await withPush();
  assert.ok(t.token);
  assert.strictEqual((await t.mb('/api/mail/push')).status, 200);
  assert.deepStrictEqual(await j(await t.mb('/api/mail/push')), { ios: true, android: true, devices: 0 });
  assert.strictEqual((await t.api('/api/mail/push')).status, 401, 'sans jeton');
  assert.strictEqual((await t.mb('/api/mail/push', {}, t.token.slice(0, -3) + 'abc')).status, 401, 'falsifié');
  assert.strictEqual((await t.api('/api/mail/push', { headers: { 'X-Demo-User': 'paul@example.com' } })).status, 401, 'session de compte refusée sur une route de boîte');
  assert.strictEqual((await t.mb('/api/workspace')).status, 401, 'session de boîte refusée sur une route de compte');
  assert.strictEqual((await t.mb('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['x.com'] } })).status, 401);
});

test('enregistrement : plateforme et jeton validés ; plateforme non configurée -> 503 ; un seul identifiant « Freda push » par boîte, chiffré', async () => {
  const t = await withPush();
  assert.strictEqual((await t.reg({ platform: 'windows', token: IOS })).status, 400);
  assert.strictEqual((await t.reg({ platform: 'ios', token: 'pas-hexa' })).status, 400);
  assert.strictEqual((await t.reg({ platform: 'android', token: 'court' })).status, 400);
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createAppPassword')).length, 0, 'rien créé pour une demande invalide');
  assert.strictEqual((await t.reg({ platform: 'ios', token: IOS })).status, 200);
  assert.strictEqual((await t.reg({ platform: 'android', token: ANDROID })).status, 200);
  assert.strictEqual((await t.reg({ platform: 'ios', token: IOS })).status, 200, 'idempotent');
  const create = t.pm.calls.filter((c) => c.path.endsWith('/createAppPassword'));
  assert.strictEqual(create.length, 1, 'un seul identifiant de surveillance');
  assert.deepStrictEqual(create[0].body, { userHandle: U, name: 'Freda push' });
  const row = await t.db.get('SELECT * FROM push_credentials');
  assert.ok(!row.secret_enc.includes('app-pw'), 'chiffré au repos');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM push_devices')).n, 2);
  t.push.stop();
  const none = await withPush({ senders: { ios: null, android: null } });
  assert.strictEqual((await none.reg({ platform: 'ios', token: IOS })).status, 503);
  assert.deepStrictEqual(await j(await none.mb('/api/mail/push')), { ios: false, android: false, devices: 0 });
  none.push.stop();
});

test('observateur : une boîte avec appareil est surveillée avec SON identifiant de surveillance ; PUSH_PREVIEW=false -> UNE notification minimale (sans expéditeur ni objet)', async () => {
  const t = await withPush({ env: { PUSH_PREVIEW: 'false' } });
  t.pmState.addMail(U, { subject: 'Ancien message' });               // déjà là avant l'enregistrement : pas de notification
  await t.reg({ platform: 'ios', token: IOS }); await t.ready();
  assert.strictEqual(t.pmState.sessions[U], 1);
  const watcherLogin = t.imap.calls.filter((c) => /^app-pw-/.test(c.pass)).pop();
  assert.strictEqual(watcherLogin.user, U, 'identifiant d’application, jamais le mot de passe du client');
  await sleep(150); assert.strictEqual(t.sent.length, 0, 'l’existant ne notifie pas');
  t.pmState.addMail(U, { subject: 'Facture confidentielle', from: 'Alice <alice@example.org>' });
  await waitFor(() => t.sent.length === 1);
  assert.deepStrictEqual(t.sent[0].msg, { title: 'Nouveau message', body: U, data: { kind: 'new_mail', mailbox: U, count: 1 }, collapseId: await t.boxId() });
  assert.ok(!JSON.stringify(t.sent[0]).includes('Facture') && !JSON.stringify(t.sent[0]).includes('Alice'), 'aucun contenu transmis à Apple / Google');
  assert.strictEqual(t.sent[0].token, IOS); assert.strictEqual(t.sent[0].platform, 'ios');
  t.push.stop();
});

test('rafale : plusieurs messages d’affilée sont regroupés (le total est exact), chaque plateforme enregistrée est notifiée', async () => {
  const t = await withPush({ debounce: 400 });
  await t.reg({ platform: 'ios', token: IOS }); await t.reg({ platform: 'android', token: ANDROID }); await t.ready();
  for (let i = 0; i < 3; i++) t.pmState.addMail(U, { subject: 'm' + i });
  await waitFor(() => t.sent.filter((s) => s.platform === 'ios').reduce((n, s) => n + s.msg.data.count, 0) === 3);
  assert.ok(t.sent.filter((s) => s.platform === 'ios').length <= 2, 'regroupé');
  assert.ok(t.sent.some((s) => s.platform === 'android'));
  assert.ok(t.sent.some((s) => s.msg.title === '3 nouveaux messages') || t.sent.length > 2);
  t.push.stop();
});

test('aperçu (par défaut) : expéditeur, objet décodés (RFC 2047) et début du message pour un message unique', async () => {
  const t = await withPush();
  await t.reg({ platform: 'android', token: ANDROID }); await t.ready();
  t.pmState.addMail(U, { subject: '=?utf-8?B?RmFjdHVyZSBkZSBqYW52aWVy?=', from: '"Alice Dupont" <alice@example.org>', body: 'Bonjour Marie, voici la facture du mois. Merci de régler avant vendredi.' });
  await waitFor(() => t.sent.length === 1);
  assert.strictEqual(t.sent[0].msg.title, 'Alice Dupont');
  assert.strictEqual(t.sent[0].msg.body, 'Facture de janvier\nBonjour Marie, voici la facture du mois. Merci de régler avant vendredi.');
  assert.strictEqual(t.sent[0].msg.data.from, 'Alice Dupont');
  t.push.stop();
});

test('extrait : quoted-printable, multipart (texte préféré au HTML), HTML dépouillé, base64, citations et liens retirés', () => {
  const { previewText } = require('../src/mail-preview');
  assert.strictEqual(previewText('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable', 'Bonjour =C3=A0 tous,=\r\n voil=C3=A0.\r\n> citation\r\nVoir https://x.com/a'), 'Bonjour à tous, voilà. Voir');
  assert.strictEqual(previewText('Content-Type: multipart/alternative; boundary="b1"', '--b1\r\nContent-Type: text/html\r\n\r\n<p>HTML</p>\r\n--b1\r\nContent-Type: text/plain\r\n\r\nTexte simple\r\n--b1--'), 'Texte simple');
  assert.strictEqual(previewText('Content-Type: text/html', '<style>p{}</style><div>Salut&nbsp;<b>Jean</b> &amp; Léa</div>'), 'Salut Jean & Léa');
  assert.strictEqual(previewText('Content-Transfer-Encoding: base64', Buffer.from('Bonjour en base64').toString('base64')), 'Bonjour en base64');
  assert.strictEqual(previewText('', 'x'.repeat(400), 20), 'x'.repeat(19) + '…');
  assert.strictEqual(previewText('Content-Type: application/pdf', 'JVBERi0='), '');
});

test('rattrapage : les messages arrivés pendant une coupure sont notifiés une seule fois au redémarrage, sans doublon', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.ready();
  t.push.stop();
  await waitFor(() => !t.pmState.sessions[U]);
  t.pmState.addMail(U, { subject: 'a' }); t.pmState.addMail(U, { subject: 'b' });
  await t.push.start(); await t.ready();
  await waitFor(() => t.sent.length === 1);
  assert.strictEqual(t.sent[0].msg.data.count, 2);
  t.push.stop(); await waitFor(() => !t.pmState.sessions[U]);
  await t.push.start(); await t.ready(); await sleep(200);
  assert.strictEqual(t.sent.length, 1, 'rien de plus au redémarrage suivant');
  t.push.stop();
});

test('jeton mort (410 / UNREGISTERED) : l’appareil est supprimé ; les autres sont conservés', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.reg({ platform: 'android', token: ANDROID }); await t.ready();
  t.sender.iosResult = { invalid: true };
  t.pmState.addMail(U, {});
  await waitFor(async () => (await t.db.get("SELECT COUNT(*) AS n FROM push_devices WHERE platform = 'ios'")).n === 0);
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM push_devices WHERE platform = 'android'")).n, 1);
  t.push.stop();
});

test('un échec d’envoi ne tue pas l’observateur : le message suivant est notifié', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.ready();
  let calls = 0;
  t.push = null; const orig = t.sender.iosResult;
  Object.defineProperty(t.sender, 'iosResult', { get() { calls++; if (calls <= 2) throw new Error('apns_503'); return orig; } });
  t.pmState.addMail(U, {}); await waitFor(() => calls >= 2);
  t.pmState.addMail(U, {}); await waitFor(() => t.sent.length >= 3);
  assert.ok((await t.db.get('SELECT COUNT(*) AS n FROM push_devices')).n === 1, 'appareil conservé');
  t.app.app.push.stop();
});

test('désenregistrement : un appareil restant garde la surveillance ; le dernier la coupe et révoque l’identifiant chez Purelymail', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.reg({ platform: 'android', token: ANDROID }); await t.ready();
  const secret = t.pmState.appPasswords[U].find((p) => p.startsWith('app-pw-'));
  assert.strictEqual((await t.mb('/api/mail/push?token=' + IOS, { method: 'DELETE' })).status, 200);
  assert.strictEqual(t.pmState.sessions[U], 1, 'toujours surveillée pour l’autre appareil');
  assert.ok(t.pmState.appPasswords[U].includes(secret));
  assert.strictEqual((await t.mb('/api/mail/push', { method: 'DELETE', body: { token: ANDROID } })).status, 200);
  await waitFor(() => !t.pmState.sessions[U]);
  assert.ok(!t.pmState.appPasswords[U].includes(secret), 'identifiant de surveillance révoqué chez Purelymail');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM push_credentials')).n, 0);
  t.push.stop();
});

test('comptes multiples : un même téléphone notifie les deux boîtes, chaque notification nomme la boîte ; retirer un compte ne coupe pas l’autre', async () => {
  const t = await withPush();
  await t.user('/api/mailboxes', { method: 'POST', body: { local: 'ventes', domain: 'neuf.com', password: 'AutreMotDePasse#1' } });
  const t2 = await t.login('ventes', 'AutreMotDePasse#1');
  await t.reg({ platform: 'ios', token: IOS });
  await t.reg({ platform: 'ios', token: IOS }, t2);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM push_devices WHERE mailbox_id = ?', await t.boxId())).n, 1);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM push_devices WHERE mailbox_id = ?', await t.boxId('ventes'))).n, 1);
  await t.push.reconcile(); await t.ready(); await t.ready('ventes');
  t.sent.length = 0; t.pmState.addMail('ventes@neuf.com', {});
  await waitFor(() => t.sent.length === 1);
  assert.strictEqual(t.sent[0].msg.data.mailbox, 'ventes@neuf.com');
  assert.strictEqual((await t.mb('/api/mail/push?token=' + IOS, { method: 'DELETE' }, t2)).status, 200);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM push_devices WHERE mailbox_id = ?', await t.boxId())).n, 1, 'l’autre compte garde ses notifications');
  t.push.stop();
});

test('suspension : observateur arrêté, session de boîte invalidée ; réactivation : l’observateur repart avec le même identifiant', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.ready();
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await t.app.app.jobs.run();
  await t.push.reconcile();
  await waitFor(() => !t.pmState.sessions[U]);
  assert.strictEqual((await t.mb('/api/mail/push')).status, 401, 'session de boîte révoquée');
  t.sent.length = 0; t.pmState.addMail(U, {}); await sleep(200);
  assert.strictEqual(t.sent.length, 0, 'aucune notification pendant la suspension');
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly' } });
  await t.push.reconcile(); await t.ready();
  assert.strictEqual(t.pmState.sessions[U], 1, 'observateur relancé sans réinscription');
  await waitFor(() => t.sent.length === 1);                           // le message arrivé pendant la suspension est rattrapé
  const fresh = await t.login(); assert.ok(fresh);
  assert.strictEqual((await t.mb('/api/mail/push', {}, fresh)).status, 200);
  t.push.stop();
});

test('changement du mot de passe de la boîte : sessions de l’application révoquées, notifications inchangées (autre identifiant)', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.ready();
  await t.user(`/api/mailboxes/${await t.boxId()}/password`, { method: 'POST', body: { password: 'NouveauMotDePasse$77' } });
  assert.strictEqual((await t.mb('/api/mail/push')).status, 401);
  t.pmState.addMail(U, {}); await waitFor(() => t.sent.length === 1);
  t.push.stop();
});

test('identifiant de surveillance révoqué côté Purelymail : l’observateur s’arrête, un nouvel identifiant est créé puis la surveillance reprend', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.ready();
  const oldSecret = t.pmState.appPasswords[U].find((p) => p.startsWith('app-pw-'));
  t.push.stop(); await waitFor(() => !t.pmState.sessions[U]);
  t.pmState.appPasswords[U] = t.pmState.appPasswords[U].filter((p) => p !== oldSecret);        // révoqué à la main dans le portail
  await t.push.start();
  await waitFor(async () => (await t.db.get('SELECT COUNT(*) AS n FROM push_credentials')).n === 0);
  await t.push.reconcile(); await t.ready();
  const fresh = t.pmState.appPasswords[U].find((p) => p.startsWith('app-pw-'));
  assert.ok(fresh && fresh !== oldSecret);
  assert.strictEqual(t.pmState.sessions[U], 1);
  t.push.stop();
});

test('suppression de la boîte : appareils, identifiant et observateur disparaissent', async () => {
  const t = await withPush();
  await t.reg({ platform: 'ios', token: IOS }); await t.ready();
  assert.strictEqual((await t.user('/api/mailboxes/' + (await t.boxId()), { method: 'DELETE' })).status, 200);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM push_devices')).n, 0);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM push_credentials')).n, 0);
  await t.push.reconcile(); assert.strictEqual(t.push.watchers().size, 0);
  t.push.stop();
});

/* ---------- envois APNs / FCM contre de faux serveurs ---------- */
test('APNs : requête HTTP/2 conforme (chemin, en-têtes, jeton ES256 vérifiable), 410 -> jeton mort, ExpiredProviderToken -> nouveau jeton, autre erreur -> exception', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const seen = []; let mode = 'ok';
  const server = http2.createServer();
  server.on('stream', (stream, h) => {
    let body = ''; stream.setEncoding('utf8'); stream.on('data', (d) => { body += d; });
    stream.on('end', () => {
      seen.push({ h, body: JSON.parse(body) });
      const reply = (status, reason) => { stream.respond({ ':status': status, 'content-type': 'application/json' }); stream.end(reason ? JSON.stringify({ reason }) : ''); };
      if (mode === 'gone') return reply(410, 'Unregistered');
      if (mode === 'bad') return reply(400, 'BadDeviceToken');
      if (mode === 'expired' && seen.filter((s) => s.h[':path'] === '/3/device/tok').length === 1) return reply(403, 'ExpiredProviderToken');
      if (mode === 'boom') return reply(500, 'InternalServerError');
      reply(200);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = { push: { apns: { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'ABC123DEFG', teamId: 'TEAM123456', bundleId: 'com.freda.mail', baseUrl: 'http://127.0.0.1:' + server.address().port } } };
  const apns = createApns(cfg);
  try {
    assert.deepStrictEqual(await apns.send('tok', { title: 'Nouveau message', body: 'a@b.c', data: { kind: 'new_mail', mailbox: 'a@b.c', count: 1 }, collapseId: 'box1' }), { ok: true });
    const { h, body } = seen[0];
    assert.strictEqual(h[':method'], 'POST'); assert.strictEqual(h[':path'], '/3/device/tok');
    assert.strictEqual(h['apns-push-type'], 'alert'); assert.strictEqual(h['apns-topic'], 'com.freda.mail'); assert.strictEqual(h['apns-priority'], '10'); assert.strictEqual(h['apns-collapse-id'], 'box1');
    assert.deepStrictEqual(body.aps.alert, { title: 'Nouveau message', body: 'a@b.c' }); assert.strictEqual(body.kind, 'new_mail');
    const [hd, pl, sig] = h.authorization.replace(/^bearer /, '').split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(hd, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG' });
    const claims = JSON.parse(Buffer.from(pl, 'base64url')); assert.strictEqual(claims.iss, 'TEAM123456'); assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
    assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'signature ES256 valide');
    await apns.send('tok2', { title: 't', body: 'b' });
    assert.strictEqual(seen[1].h.authorization, h.authorization, 'jeton mis en cache (pas de renouvellement à chaque envoi)');
    mode = 'gone'; assert.deepStrictEqual(await apns.send('tok', { title: 't', body: 'b' }), { invalid: true });
    mode = 'bad'; assert.deepStrictEqual(await apns.send('tok', { title: 't', body: 'b' }), { invalid: true });
    mode = 'expired'; seen.length = 0; assert.deepStrictEqual(await apns.send('tok', { title: 't', body: 'b' }), { ok: true });
    assert.strictEqual(seen.length, 2, 'une seule nouvelle tentative après ExpiredProviderToken');
    mode = 'boom'; await assert.rejects(apns.send('tok', { title: 't', body: 'b' }), /apns_500/);
  } finally { apns.close(); server.close(); }
});

test('FCM : jeton OAuth2 (JWT RS256 vérifiable) mis en cache, message HTTP v1 conforme, UNREGISTERED -> jeton mort, 401 -> nouveau jeton', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const http = require('node:http');
  const oauth = []; const sends = []; let mode = 'ok', tokenN = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const out = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/oauth') { oauth.push(Object.fromEntries(new URLSearchParams(body))); return out(200, { access_token: 'at-' + (++tokenN), expires_in: 3600 }); }
      sends.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      if (mode === 'gone') return out(404, { error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
      if (mode === 'expired' && sends.length === 1) return out(401, { error: { status: 'UNAUTHENTICATED' } });
      if (mode === 'boom') return out(500, { error: { status: 'INTERNAL' } });
      out(200, { name: 'projects/p/messages/1' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const cfg = { push: { fcm: { baseUrl: base, serviceAccount: { project_id: 'proj-1', client_email: 'svc@proj-1.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: base + '/oauth' } } } };
  const fcm = createFcm(cfg);
  try {
    assert.deepStrictEqual(await fcm.send('devtoken', { title: 'Nouveau message', body: 'a@b.c', data: { kind: 'new_mail', mailbox: 'a@b.c', count: 2 }, collapseId: 'box1' }), { ok: true });
    assert.strictEqual(oauth[0].grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [hd, pl, sig] = oauth[0].assertion.split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(hd, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(pl, 'base64url'));
    assert.deepStrictEqual([claims.iss, claims.scope, claims.aud], ['svc@proj-1.iam.gserviceaccount.com', 'https://www.googleapis.com/auth/firebase.messaging', base + '/oauth']);
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${hd}.${pl}`), publicKey, Buffer.from(sig, 'base64url')), 'signature RS256 valide');
    assert.strictEqual(sends[0].url, '/v1/projects/proj-1/messages:send'); assert.strictEqual(sends[0].auth, 'Bearer at-1');
    const m = sends[0].body.message;
    assert.strictEqual(m.token, 'devtoken'); assert.deepStrictEqual(m.notification, { title: 'Nouveau message', body: 'a@b.c' });
    assert.deepStrictEqual(m.data, { kind: 'new_mail', mailbox: 'a@b.c', count: '2' }, 'valeurs de data = chaînes');
    assert.strictEqual(m.android.priority, 'HIGH'); assert.strictEqual(m.android.notification.tag, 'box1');
    await fcm.send('devtoken', { title: 't', body: 'b' });
    assert.strictEqual(oauth.length, 1, 'jeton OAuth mis en cache');
    mode = 'gone'; assert.deepStrictEqual(await fcm.send('devtoken', { title: 't', body: 'b' }), { invalid: true });
    mode = 'expired'; sends.length = 0; assert.deepStrictEqual(await fcm.send('devtoken', { title: 't', body: 'b' }), { ok: true });
    assert.strictEqual(oauth.length, 2, 'nouveau jeton OAuth après 401');
    mode = 'boom'; await assert.rejects(fcm.send('devtoken', { title: 't', body: 'b' }), /fcm_500/);
  } finally { server.closeAllConnections(); server.close(); }
});

test('configuration push : jeux d’identifiants incomplets ou invalides -> démarrage refusé', () => {
  const base = { NAMESILO_API_KEY: 'k', JWT_SECRET: 'j'.repeat(40), PAYMENTS_PROVIDER: 'demo', PURELYMAIL_API_KEY: 'p' };
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.ok(assertSafe(loadConfig({ ...base, APNS_KEY: ec })).some((e) => /APNS_KEY/.test(e)));
  assert.ok(!assertSafe(loadConfig({ ...base, APNS_KEY: ec, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_BUNDLE_ID: 'b' })).some((e) => /APNS/.test(e)));
  assert.ok(!assertSafe(loadConfig({ ...base, APNS_KEY: Buffer.from(ec).toString('base64'), APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_BUNDLE_ID: 'b' })).some((e) => /APNS/.test(e)), 'clé en base64 acceptée');
  assert.ok(assertSafe(loadConfig({ ...base, FCM_SERVICE_ACCOUNT: '{pas du json' })).some((e) => /FCM_SERVICE_ACCOUNT/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, FCM_SERVICE_ACCOUNT: '{"project_id":"p"}' })).some((e) => /FCM_SERVICE_ACCOUNT/.test(e)));
  const { PURELYMAIL_API_KEY, ...noPm } = base;
  assert.ok(assertSafe(loadConfig({ ...noPm, APNS_KEY: ec, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_BUNDLE_ID: 'b' })).some((e) => /PURELYMAIL_API_KEY/.test(e)));
});
