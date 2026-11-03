const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
const { createVault } = require('../src/vault');
const { loadConfig, assertSafe } = require('../src/config');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const j = (r) => r.json();

async function withMail(over = {}) {
  const t = await setup({ payments: demoPay, ...over });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact' } } });
  t.boxId = t.db.get('SELECT id FROM mailboxes').id;
  t.mailer.sent.length = 0;
  t.add = (body = { name: 'iPhone de Claire', platform: 'ios' }, as) => (as ? t.as(as) : t.user)(`/api/mailboxes/${t.boxId}/devices`, { method: 'POST', body });
  return t;
}

test('appareil : mot de passe d’application PROPRE à l’appareil, renvoyé une seule fois avec les réglages IMAP/SMTP ; jamais stocké en clair', async () => {
  const t = await withMail();
  const r = await t.add();
  assert.strictEqual(r.status, 200);
  const out = await j(r);
  assert.deepStrictEqual(out.credentials.imap, { host: 'imap.purelymail.com', port: 993, security: 'ssl' });
  assert.deepStrictEqual(out.credentials.smtp, { host: 'smtp.purelymail.com', port: 465, security: 'ssl', alternative: { port: 587, security: 'starttls' } });
  assert.strictEqual(out.credentials.username, 'contact@neuf.com');
  const call = t.pm.calls.find((c) => c.path.endsWith('/createAppPassword')).body;
  assert.deepStrictEqual(call, { userHandle: 'contact@neuf.com', name: 'Freda · iPhone de Claire' });
  assert.ok(t.pmState.login('contact@neuf.com', out.credentials.appPassword), 'le mot de passe fonctionne chez Purelymail');
  assert.ok(!JSON.stringify(t.db.all('SELECT * FROM devices')).includes(out.credentials.appPassword), 'chiffré au repos');
  const list = await j(await t.user('/api/devices'));
  assert.deepStrictEqual(list.devices.map((d) => [d.name, d.platform, d.mailbox]), [['iPhone de Claire', 'ios', 'contact@neuf.com']]);
  assert.ok(!JSON.stringify(list).includes(out.credentials.appPassword) && !JSON.stringify(await j(await t.user('/api/workspace'))).includes(out.credentials.appPassword), 'jamais relisible');
  assert.ok(t.mailer.sent.some((m) => /Nouvel appareil/.test(m.subject) && /iPhone de Claire/.test(m.text)), 'le titulaire est prévenu');
});

test('appareil : chaque appareil a son propre mot de passe ; plateforme normalisée ; nom obligatoire ; limite par boîte', async () => {
  const t = await withMail({ env: { MAX_DEVICES_PER_MAILBOX: '2' } });
  const a = await j(await t.add({ name: 'Pixel', platform: 'android' })), b = await j(await t.add({ name: 'Tablette', platform: 'windows-phone' }));
  assert.notStrictEqual(a.credentials.appPassword, b.credentials.appPassword);
  assert.strictEqual(b.device.platform, 'other');
  assert.strictEqual((await t.add({ name: '   ' })).status, 400);
  assert.strictEqual((await t.add({ name: 'Troisième' })).status, 403);
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM devices').n, 2);
});

test('appareil : isolation entre comptes, offre obligatoire, boîte non prête -> aucun mot de passe créé', async () => {
  const t = await withMail();
  assert.strictEqual((await t.add(undefined, 'autre@example.com')).status, 404, 'boîte d’un autre compte');
  assert.strictEqual((await (t.as('autre@example.com'))('/api/devices')).status, 200);
  assert.deepStrictEqual((await j(await t.as('autre@example.com')('/api/devices'))).devices, []);
  t.db.run("UPDATE mailboxes SET provider_status = 'pending_provider'");
  assert.strictEqual((await t.add()).status, 503);
  t.db.run("UPDATE mailboxes SET provider_status = 'active'"); t.db.run('DELETE FROM subscriptions');
  assert.strictEqual((await t.add()).status, 402);
  assert.ok(!t.pm.calls.some((c) => c.path.endsWith('/createAppPassword')));
});

test('retrait d’un appareil : mot de passe supprimé chez Purelymail (accès coupé tout de suite) ; panne -> 502 et l’appareil reste listé', async () => {
  const t = await withMail();
  const out = await j(await t.add());
  const id = out.device.id;
  assert.strictEqual((await t.as('autre@example.com')('/api/devices/' + id, { method: 'DELETE' })).status, 404);
  t.pmState.fail = true;
  assert.strictEqual((await t.user('/api/devices/' + id, { method: 'DELETE' })).status, 502);
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM devices').n, 1, 'pas de faux « retiré »');
  t.pmState.fail = false;
  assert.strictEqual((await t.user('/api/devices/' + id, { method: 'DELETE' })).status, 200);
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/deleteAppPassword')).pop().body.appPassword, out.credentials.appPassword, 'la valeur d’origine est retrouvée (déchiffrée)');
  assert.ok(!t.pmState.login('contact@neuf.com', out.credentials.appPassword), 'plus d’accès');
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM devices').n, 0);
});

test('suspension : les appareils perdent l’accès (même mot de passe d’application) ; réactivation : ils refonctionnent SANS reconfiguration', async () => {
  const t = await withMail();
  const out = await j(await t.add());
  const pw = out.credentials.appPassword;
  assert.ok(t.pmState.login('contact@neuf.com', pw));
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await t.app.app.jobs.run();
  assert.ok(!t.pmState.login('contact@neuf.com', pw), 'accès coupé');
  assert.strictEqual((await t.add({ name: 'Nouveau' })).status, 402, 'offre suspendue : pas de nouvel appareil');
  assert.strictEqual((await j(await t.user('/api/mailboxes'))).mailboxes[0].status, 'suspended', 'l’application peut afficher « abonnement expiré »');
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly' } });
  assert.ok(t.pmState.login('contact@neuf.com', pw), 'même mot de passe d’application, rien à reconfigurer');
  const del = await t.user('/api/devices/' + out.device.id, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
});

test('retrait d’un appareil pendant la suspension : supprimé sous le nom actuel chez Purelymail', async () => {
  const t = await withMail();
  const out = await j(await t.add());
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await t.app.app.jobs.run();
  assert.strictEqual((await t.user('/api/devices/' + out.device.id, { method: 'DELETE' })).status, 200);
  assert.match(t.pm.calls.filter((c) => c.path.endsWith('/deleteAppPassword')).pop().body.userName, /^susp-[0-9a-f]{10}@neuf\.com$/);
});

test('suppression de la boîte : ses appareils disparaissent', async () => {
  const t = await withMail();
  await t.add();
  assert.strictEqual((await t.user('/api/mailboxes/' + t.boxId, { method: 'DELETE' })).status, 200);
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM devices').n, 0);
});

test('réglages de connexion : authentification obligatoire', async () => {
  const t = await withMail();
  assert.strictEqual((await t.api('/api/mail/config')).status, 401);
  assert.strictEqual((await j(await t.user('/api/mail/config'))).imap.port, 993);
  assert.strictEqual((await t.api('/api/devices')).status, 401);
});

test('coffre : AES-256-GCM, falsification détectée ; clé invalide refusée ; DATA_KEY obligatoire en production', () => {
  const base = { NAMESILO_API_KEY: 'k', JWT_SECRET: 'j'.repeat(40), PAYMENTS_PROVIDER: 'demo', PURELYMAIL_API_KEY: 'p' };
  const v = createVault(loadConfig({ ...base, DATA_KEY: 'a'.repeat(64) }));
  const blob = v.encrypt('secret app pw');
  assert.ok(!blob.includes('secret'));
  assert.strictEqual(v.decrypt(blob), 'secret app pw');
  assert.notStrictEqual(v.encrypt('x'), v.encrypt('x'), 'IV aléatoire');
  const bad = blob.slice(0, -2) + (blob.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => v.decrypt(bad));
  assert.throws(() => v.decrypt('n’importe quoi'));
  assert.throws(() => createVault(loadConfig({ ...base, DATA_KEY: 'court' })));
  assert.ok(assertSafe(loadConfig({ ...base, NODE_ENV: 'production', MAILER: 'brevo', BREVO_API_KEY: 'b' })).some((e) => /DATA_KEY/.test(e)));
  assert.ok(!assertSafe(loadConfig({ ...base, DATA_KEY: 'a'.repeat(64), NODE_ENV: 'production', MAILER: 'brevo', BREVO_API_KEY: 'b' })).some((e) => /DATA_KEY/.test(e)));
});
