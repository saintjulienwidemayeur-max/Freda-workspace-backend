const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { withApi, raw, j, waitFor } = require('./api-helpers');
const { closeAll } = require('./helpers');
const { validateUrl, isBlockedIp, postJson } = require('../src/webhooks');
const closers = [];
test.after(async () => { closers.forEach((c) => c()); await closeAll(); });
const mk = async (over) => { const t = await withApi(over); closers.push(t.close); return t; };

/** Récepteur de webhook : garde les requêtes ; t.status = fonction (n° de requête) -> code HTTP. */
async function receiver(status = () => 200) {
  const got = [];
  const server = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    got.push({ headers: req.headers, raw: Buffer.concat(c).toString('utf8') });
    res.statusCode = status(got.length); res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { got, url: `http://127.0.0.1:${server.address().port}/hook` };
}
const sig = (secret, h, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(`${h['x-freda-timestamp']}.${body}`).digest('hex');

test('validateUrl : https public seulement ; locales, privées, métadonnées cloud, identifiants et IPv6 mappées refusés', () => {
  assert.ok(validateUrl('https://hooks.zapier.com/hooks/catch/1/abc/'));
  assert.ok(validateUrl('https://n8n.exemple.com:8443/webhook/x?y=1'));
  for (const bad of ['http://hooks.zapier.com/x', 'ftp://x.com/', 'https://localhost/x', 'https://localhost:3000/', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.10/x', 'https://172.16.0.1/x',
    'https://169.254.169.254/latest/meta-data/', 'https://100.64.0.1/', 'https://[::1]/x', 'https://[::ffff:10.0.0.1]/x', 'https://[fd00::1]/x', 'https://intranet/x', 'https://app.internal/x', 'https://user:pass@exemple.com/x', 'pas une url', 'https://' + 'a'.repeat(600) + '.com'])
    assert.throws(() => validateUrl(bad), /invalide|autorisée|https|identifiants|trop longue/i, bad);
  assert.ok(validateUrl('http://127.0.0.1:9/x', { allowPrivate: true }), 'tests seulement');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '224.0.0.1', 'pas-une-ip']) assert.strictEqual(isBlockedIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.strictEqual(isBlockedIp(ip), false, ip);
});

test('postJson : un nom qui se résout vers une adresse privée est refusé À LA CONNEXION (anti DNS rebinding), aucune requête partie', async () => {
  const r = await receiver();
  const url = r.url.replace('127.0.0.1', 'localhost');
  await assert.rejects(postJson(url, '{}', {}, { allowPrivate: false }), (e) => e.code === 'EBLOCKED');
  assert.strictEqual(r.got.length, 0);
  assert.strictEqual((await postJson(r.url, '{}', {}, { allowPrivate: true })).status, 200);
});

test('webhook (session de boîte uniquement) : URL validée, secret montré une seule fois, rotation, test, suppression', async () => {
  const t = await mk({ deps: { webhookAllowPrivate: false } });
  const put = (url) => t.mb('/api/mail/webhook', { method: 'PUT', body: { url } });
  assert.deepStrictEqual(await j(await t.mb('/api/mail/webhook')), { configured: false });
  assert.strictEqual((await t.api('/api/mail/webhook')).status, 401);
  for (const bad of ['http://exemple.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'nimporte', '']) assert.strictEqual((await put(bad)).status, 400, bad);
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createAppPassword')).length, 0, 'rien créé pour une URL refusée');
  const r = await put('https://hooks.exemple.com/in');
  assert.strictEqual(r.status, 200);
  const first = await j(r);
  assert.match(first.secret, /^whsec_[A-Za-z0-9_-]{32}$/); assert.strictEqual(first.active, true);
  const g = await j(await t.mb('/api/mail/webhook'));
  assert.strictEqual(g.configured, true); assert.ok(!('secret' in g)); assert.strictEqual(g.url, 'https://hooks.exemple.com/in');
  assert.ok(!JSON.stringify(await t.db.all('SELECT * FROM api_webhooks')).includes(first.secret), 'secret chiffré en base');
  const again = await j(await put('https://hooks.exemple.com/autre'));
  assert.ok(!('secret' in again), 'modifier l’URL garde le même secret (pas de rupture de signature)'); assert.strictEqual(again.url, 'https://hooks.exemple.com/autre');
  const rot = await j(await t.mb('/api/mail/webhook/secret', { method: 'POST' }));
  assert.ok(rot.secret && rot.secret !== first.secret);
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createAppPassword')).length, 1);
  assert.strictEqual((await t.mb('/api/mail/webhook', { method: 'DELETE' })).status, 200);
  assert.deepStrictEqual(await j(await t.mb('/api/mail/webhook')), { configured: false });
  assert.strictEqual(t.pmState.appPasswords['contact@neuf.com'].length, 0, 'sans clé ni webhook : identifiant révoqué');
  assert.strictEqual((await t.mb('/api/mail/webhook/test', { method: 'POST' })).status, 404);
  assert.strictEqual((await t.mb('/api/mail/webhook/secret', { method: 'POST' })).status, 404);
});

test('livraison : en-têtes, signature HMAC vérifiable, nouvelle tentative sur 5xx, jamais sur 4xx, désactivation après 10 échecs, réactivation', async () => {
  const t = await mk();
  const rc = await receiver((n) => (n <= 2 ? 500 : 200));
  const { secret } = await j(await t.mb('/api/mail/webhook', { method: 'PUT', body: { url: rc.url } }));
  const r = await j(await t.mb('/api/mail/webhook/test', { method: 'POST' }));
  assert.deepStrictEqual([r.delivered, r.attempts, r.status], [true, 3, '200'], '2 échecs 5xx puis succès');
  const last = rc.got[2];
  assert.strictEqual(last.headers['x-freda-event'], 'webhook.test'); assert.match(last.headers['x-freda-delivery'], /^dlv_/);
  assert.strictEqual(last.headers['x-freda-signature'], sig(secret, last.headers, last.raw), 'signature = HMAC-SHA256(secret, timestamp.corps)');
  assert.ok(Math.abs(Date.now() / 1000 - Number(last.headers['x-freda-timestamp'])) < 30);
  assert.notStrictEqual(last.headers['x-freda-signature'], sig('whsec_autre', last.headers, last.raw));
  assert.strictEqual(JSON.parse(last.raw).event, 'webhook.test');
  const rc4 = await receiver(() => 400);
  await t.mb('/api/mail/webhook', { method: 'PUT', body: { url: rc4.url } });
  const r4 = await j(await t.mb('/api/mail/webhook/test', { method: 'POST' }));
  assert.deepStrictEqual([r4.delivered, r4.attempts, r4.status], [false, 1, '400'], '4xx : pas de nouvelle tentative');
  for (let i = 0; i < 9; i++) await t.mb('/api/mail/webhook/test', { method: 'POST' });
  const g = await j(await t.mb('/api/mail/webhook'));
  assert.deepStrictEqual([g.active, g.disabledReason], [false, 'too_many_failures']);
  assert.strictEqual(g.failures, 10);
  assert.strictEqual((await j(await t.mb('/api/mail/webhook', { method: 'PUT', body: { url: rc.url } }))).active, true, 'réactivé en enregistrant à nouveau l’URL');
  assert.strictEqual((await j(await t.mb('/api/mail/webhook'))).failures, 0);
});

test('temps réel : un nouveau message arrivé déclenche un POST signé avec son contenu ; les messages déjà présents ne sont pas renvoyés', async () => {
  const t = await mk();
  const rc = await receiver();
  const { secret } = await j(await t.mb('/api/mail/webhook', { method: 'PUT', body: { url: rc.url } }));
  const id = await t.boxId();
  await (await waitFor(() => t.app.app.webhooks.watchers().get(id))).w.ready;
  assert.strictEqual(rc.got.length, 0, 'pas de rattrapage de l’historique');
  t.imapServer.appendMessage('INBOX', [], false, raw('m3', 'Nouvelle commande', 'In-Reply-To: <m1@ex.com>\r\nReferences: <m1@ex.com>\r\n', 'Bonjour, je voudrais commander.'));
  const hit = await waitFor(() => rc.got.find((x) => JSON.parse(x.raw).event === 'message.received'));
  const body = JSON.parse(hit.raw);
  assert.strictEqual(body.mailbox, 'contact@neuf.com'); assert.strictEqual(body.message.subject, 'Nouvelle commande');
  assert.match(body.message.text, /voudrais commander/); assert.strictEqual(body.message.from.address, 'marie@ex.com'); assert.strictEqual(body.message.thread_id, '<m1@ex.com>');
  assert.strictEqual(body.message.unread, true); assert.ok(body.message.id);
  assert.strictEqual(hit.headers['x-freda-signature'], sig(secret, hit.headers, hit.raw));
  // l'agent peut relire ce message avec l'API (même identifiant)
  const k = await t.newKey('read');
  assert.strictEqual((await j(await t.v1('/messages/' + encodeURIComponent(body.message.id), k.key))).subject, 'Nouvelle commande');
  t.imapServer.appendMessage('INBOX', [], false, raw('m4', 'Deuxieme'));
  await waitFor(() => rc.got.filter((x) => JSON.parse(x.raw).event === 'message.received').length === 2);
  assert.deepStrictEqual(rc.got.map((x) => JSON.parse(x.raw).message.subject), ['Nouvelle commande', 'Deuxieme']);
});

test('webhook : un mot de passe de boîte changé après sa création le rend inactif (observateur arrêté)', async () => {
  const t = await mk();
  const rc = await receiver();
  await t.mb('/api/mail/webhook', { method: 'PUT', body: { url: rc.url } });
  const id = await t.boxId();
  await waitFor(() => t.app.app.webhooks.watchers().get(id));
  assert.strictEqual((await t.user(`/api/mailboxes/${id}/password`, { method: 'POST', body: { password: 'Autre-Mot-De-Passe-2027' } })).status, 200);
  await t.app.app.webhooks.reconcile();
  assert.strictEqual(t.app.app.webhooks.watchers().has(id), false);
});
