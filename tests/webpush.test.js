const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup, closeAll } = require('./helpers');
const { createWebPush, canonicalSubscription, endpointOk, vapidKeysValid, generateVapidKeys, encrypt } = require('../src/webpush');
const { loadConfig, assertSafe } = require('../src/config');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const PW = 'MonMotDePasse!2026';
const j = (r) => r.json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('délai dépassé'); await sleep(15); } }
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

/** Un « navigateur » : paire de clés P-256 + secret d'authentification, comme PushManager.subscribe(). */
function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}
/** Déchiffrement côté navigateur (RFC 8291 §4) : prouve que le corps envoyé est lisible par le destinataire. */
function decrypt(body, ecdh, auth) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  assert.strictEqual(rs, 4096);
  const secret = ecdh.computeSecret(asPub), uaPub = ecdh.getPublicKey();
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, 'délimiteur du dernier enregistrement');
  return plain.subarray(0, plain.length - 1);
}

test('RFC 8291 §5 : le vecteur de test de la norme donne exactement le même corps chiffré', () => {
  const body = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), fromB64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), fromB64u('BTBZMqHH6r4Tts7J_aSIgg'),
    { asKey: fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.strictEqual(b64u(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('chiffrement : le navigateur retrouve le message (aller-retour), et chaque envoi utilise un sel et une clé éphémère différents', () => {
  const b = browser();
  const msg = Buffer.from(JSON.stringify({ title: 'Équipe Freda', body: 'Bienvenue — é à ü 🎉' }));
  const one = encrypt(msg, b.ecdh.getPublicKey(), b.auth), two = encrypt(msg, b.ecdh.getPublicKey(), b.auth);
  assert.deepStrictEqual(decrypt(one, b.ecdh, b.auth), msg);
  assert.deepStrictEqual(decrypt(two, b.ecdh, b.auth), msg);
  assert.notDeepStrictEqual(one, two);
  assert.throws(() => decrypt(one, b.ecdh, crypto.randomBytes(16)), 'mauvais secret d’authentification : illisible');
});

test('VAPID : paire valide / invalide ; en-tête Authorization signé ES256, audience = origine du service de push, expiration < 24 h', async () => {
  const k = generateVapidKeys();
  assert.ok(vapidKeysValid(k.publicKey, k.privateKey));
  assert.ok(!vapidKeysValid(k.publicKey, generateVapidKeys().privateKey), 'privée d’une autre paire');
  assert.ok(!vapidKeysValid('', '') && !vapidKeysValid('abc', 'def'));
  const calls = [];
  const wp = createWebPush({ push: { web: { ...k, subject: 'mailto:support@fredaworkspace.com' } } }, { fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 201 }; } });
  const b = browser('https://updates.push.services.mozilla.com/wpush/v2/xyz');
  assert.deepStrictEqual(await wp.send(JSON.stringify(b.sub), { title: 'T', body: 'B', data: { kind: 'new_mail', mailbox: 'a@b.c' }, collapseId: 'mbx_0123456789abcdef' }), { ok: true });
  const h = calls[0].init.headers;
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization);
  assert.ok(m); assert.strictEqual(m[2], k.publicKey);
  const [hd, pl, sig] = m[1].split('.');
  assert.deepStrictEqual(JSON.parse(fromB64u(hd)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(fromB64u(pl));
  assert.strictEqual(claims.aud, 'https://updates.push.services.mozilla.com'); assert.strictEqual(claims.sub, 'mailto:support@fredaworkspace.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
  const pub = fromB64u(k.publicKey);
  const vk = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key: vk, dsaEncoding: 'ieee-p1363' }, fromB64u(sig)), 'signature valide');
  assert.deepStrictEqual([h['Content-Encoding'], h.TTL, h.Urgency, h.Topic], ['aes128gcm', '3600', 'high', 'mbx_0123456789abcdef']);
  const plain = JSON.parse(decrypt(calls[0].init.body, b.ecdh, b.auth));
  assert.deepStrictEqual([plain.title, plain.body, plain.data.mailbox, plain.tag], ['T', 'B', 'a@b.c', 'mbx_0123456789abcdef']);
  assert.strictEqual(calls[0].init.redirect, 'error', 'jamais de redirection suivie');
});

test('réponses du service de push : 201 ok ; 404 / 410 / 403 = abonnement mort ; 5xx = erreur (nouvelle tentative)', async () => {
  const k = generateVapidKeys(); let status = 201;
  const wp = createWebPush({ push: { web: { ...k, subject: 'mailto:a@b.co' } } }, { fetchImpl: async () => ({ status }) });
  const tok = JSON.stringify(browser().sub);
  assert.deepStrictEqual(await wp.send(tok, { title: 't', body: 'b' }), { ok: true });
  for (const s of [404, 410, 403, 401]) { status = s; assert.deepStrictEqual(await wp.send(tok, { title: 't', body: 'b' }), { invalid: true }, String(s)); }
  status = 503; await assert.rejects(wp.send(tok, { title: 't', body: 'b' }), /webpush_503/);
  status = 429; await assert.rejects(wp.send(tok, { title: 't', body: 'b' }), /webpush_429/);
});

test('SÉCURITÉ : l’endpoint vient du navigateur — seuls les vrais services de push en https sont appelés (pas de SSRF)', async () => {
  const b = browser();
  const withEndpoint = (e) => ({ ...b.sub, endpoint: e });
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data', 'https://api.fredaworkspace.com/api/admin', 'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'ftp://fcm.googleapis.com/x', 'javascript:alert(1)', 'pas une url', '']) {
    assert.strictEqual(endpointOk(bad), false, bad);
    assert.strictEqual(canonicalSubscription(withEndpoint(bad)), null, bad);
  }
  for (const good of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q123', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.strictEqual(endpointOk(good), true, good);
  assert.strictEqual(canonicalSubscription({ ...b.sub, keys: { p256dh: b.sub.keys.p256dh, auth: 'court' } }), null, 'secret d’authentification de 16 octets');
  assert.strictEqual(canonicalSubscription({ ...b.sub, keys: { p256dh: 'AAAA', auth: b.sub.keys.auth } }), null, 'clé publique de 65 octets');
  assert.strictEqual(canonicalSubscription('{pas du json'), null);
  const k = generateVapidKeys(); let called = false;
  const wp = createWebPush({ push: { web: { ...k, subject: 'mailto:a@b.co' } } }, { fetchImpl: async () => { called = true; return { status: 201 }; } });
  assert.deepStrictEqual(await wp.send(JSON.stringify(withEndpoint('https://169.254.169.254/x')), { title: 't', body: 'b' }), { invalid: true });
  assert.strictEqual(called, false, 'aucun appel réseau vers un hôte inconnu');
});

test('configuration : paire VAPID incohérente refusée au démarrage ; absente = Web Push simplement désactivé', () => {
  const base = { NAMESILO_API_KEY: 'k', JWT_SECRET: 'j'.repeat(40), PURELYMAIL_API_KEY: 'pm' };
  const k = generateVapidKeys();
  assert.ok(!assertSafe(loadConfig({ ...base })).some((e) => /VAPID/.test(e)));
  assert.ok(!assertSafe(loadConfig({ ...base, VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey })).some((e) => /VAPID/.test(e)));
  assert.ok(assertSafe(loadConfig({ ...base, VAPID_PUBLIC_KEY: k.publicKey })).some((e) => /VAPID/.test(e)), 'publique seule');
  assert.ok(assertSafe(loadConfig({ ...base, VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey })).some((e) => /VAPID/.test(e)), 'privée d’une autre paire');
  assert.ok(assertSafe(loadConfig({ ...base, VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: 'pas-valide' })).some((e) => /VAPID_SUBJECT/.test(e)));
});

async function withWeb(fetchImpl) {
  const k = generateVapidKeys();
  const sent = [];
  const t = await setup({
    payments: demoPay, env: { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey },
    deps: { pushDebounceMs: 30, pushSenders: { ios: null, android: null, web: createWebPush({ push: { web: { ...k, subject: 'mailto:a@b.co' } } }, { fetchImpl: async (url, init) => { sent.push({ url, init }); return fetchImpl(url, init); } }) } },
  });
  t.vapid = k; t.sent = sent;
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } });
  const r = await t.api('/api/mail/login', { method: 'POST', body: { email: 'contact@neuf.com', password: PW } });
  t.token = (await j(r)).token;
  t.mb = (path, opts = {}) => t.api(path, { ...opts, headers: { Authorization: 'Bearer ' + t.token, ...(opts.headers || {}) } });
  t.boxId = async () => (await t.db.get('SELECT id FROM mailboxes WHERE local_part = ?', 'contact')).id;
  return t;
}

test('web : /api/mail/push donne la clé publique VAPID ; abonnement enregistré (canonique, idempotent), invalide refusé, endpoint interne refusé', async () => {
  const t = await withWeb(async () => ({ status: 201 }));
  const info = await j(await t.mb('/api/mail/push'));
  assert.deepStrictEqual([info.web, info.vapidPublicKey, info.devices], [true, t.vapid.publicKey, 0]);
  const b = browser();
  assert.strictEqual((await t.mb('/api/mail/push', { method: 'POST', body: { platform: 'web', token: { endpoint: 'https://169.254.169.254/x', keys: b.sub.keys } } })).status, 400);
  assert.strictEqual((await t.mb('/api/mail/push', { method: 'POST', body: { platform: 'web', token: 'n’importe quoi' } })).status, 400);
  assert.strictEqual((await t.mb('/api/mail/push', { method: 'POST', body: { platform: 'web', token: { endpoint: b.sub.endpoint, keys: { p256dh: 'x', auth: 'y' } } } })).status, 400);
  assert.strictEqual((await t.mb('/api/mail/push', { method: 'POST', body: { platform: 'web', token: b.sub } })).status, 200);
  assert.strictEqual((await t.mb('/api/mail/push', { method: 'POST', body: { platform: 'web', token: JSON.stringify({ keys: b.sub.keys, endpoint: b.sub.endpoint }) } })).status, 200, 'même abonnement, autre forme : pas de doublon');
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM push_devices WHERE platform = 'web'")).n, 1);
  assert.strictEqual((await j(await t.mb('/api/mail/push'))).devices, 1);
});

test('web : un nouveau message envoie une notification CHIFFRÉE à l’abonnement ; 410 -> abonnement supprimé ; désabonnement par DELETE', async () => {
  let status = 201;
  const t = await withWeb(async () => ({ status }));
  const b = browser();
  await t.mb('/api/mail/push', { method: 'POST', body: { platform: 'web', token: b.sub } });
  const id = await t.boxId();
  t.app.app.push.notify(id, { count: 2 });
  const call = await waitFor(() => t.sent[0]);
  assert.strictEqual(call.url, b.sub.endpoint);
  const plain = JSON.parse(decrypt(call.init.body, b.ecdh, b.auth));
  assert.deepStrictEqual([plain.title, plain.body, plain.data.kind, plain.data.mailbox, plain.data.count], ['2 nouveaux messages', 'contact@neuf.com', 'new_mail', 'contact@neuf.com', 2]);
  assert.ok(!Buffer.from(call.init.body).toString('utf8').includes('contact@neuf.com'), 'rien en clair dans ce qui transite par le service de push');
  status = 410; t.app.app.push.notify(id, { count: 1 });
  await waitFor(async () => (await t.db.get("SELECT COUNT(*) AS n FROM push_devices WHERE platform = 'web'")).n === 0);
  await t.mb('/api/mail/push', { method: 'POST', body: { platform: 'web', token: b.sub } });
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM push_devices")).n, 1);
  const del = await t.mb('/api/mail/push?token=' + encodeURIComponent(JSON.stringify(b.sub)), { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM push_devices")).n, 0);
});

test('sans clés VAPID : le Web Push est désactivé (503) sans toucher aux autres plateformes', async () => {
  const t = await setup({ payments: demoPay });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } });
  const token = (await j(await t.api('/api/mail/login', { method: 'POST', body: { email: 'contact@neuf.com', password: PW } }))).token;
  const info = await j(await t.api('/api/mail/push', { headers: { Authorization: 'Bearer ' + token } }));
  assert.deepStrictEqual([info.web, info.vapidPublicKey], [false, '']);
  const r = await t.api('/api/mail/push', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { platform: 'web', token: browser().sub } });
  assert.strictEqual(r.status, 503);
});
