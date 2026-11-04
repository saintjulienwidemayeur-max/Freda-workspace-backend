const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const j = (r) => r.json();
const PW = 'MonMotDePasse!2026';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]);

async function withTwo() {
  const t = await setup({ payments: demoPay });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } });
  await t.user('/api/mailboxes', { method: 'POST', body: { domain: 'neuf.com', local: 'love', password: PW } });
  const login = async (local) => (await j(await t.api('/api/mail/login', { method: 'POST', body: { email: `${local}@neuf.com`, password: PW } }))).token;
  t.tok = { contact: await login('contact'), love: await login('love') };
  t.put = (token, body, type = 'image/jpeg') => fetch(t.base + '/api/mail/photo', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': type }, body });
  t.get = (token, addr, headers = {}) => fetch(t.base + '/api/mail/photo/' + encodeURIComponent(addr), { headers: { Authorization: 'Bearer ' + token, ...headers } });
  t.look = (token, addresses) => t.api('/api/mail/photos', { method: 'POST', body: { addresses }, headers: { Authorization: 'Bearer ' + token } });
  return t;
}

test('photo de profil : envoi, lecture par un autre utilisateur de l’application, ETag, suppression', async () => {
  const t = await withTwo();
  const r = await t.put(t.tok.contact, JPEG);
  assert.strictEqual(r.status, 200);
  const { version } = await j(r);
  const g = await t.get(t.tok.love, 'contact@neuf.com');
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await g.arrayBuffer()).equals(JPEG));
  assert.strictEqual(g.headers.get('etag'), `"${version}"`);
  assert.strictEqual((await t.get(t.tok.love, 'contact@neuf.com', { 'If-None-Match': `"${version}"` })).status, 304);
  assert.deepStrictEqual(await j(await t.look(t.tok.love, ['contact@neuf.com', 'LOVE@neuf.com', 'inconnu@neuf.com'])), { photos: { 'contact@neuf.com': version } });
  assert.strictEqual((await t.api('/api/mail/photo', { method: 'DELETE', headers: { Authorization: 'Bearer ' + t.tok.contact } })).status, 200);
  assert.strictEqual((await t.get(t.tok.love, 'contact@neuf.com')).status, 404);
  assert.deepStrictEqual(await j(await t.look(t.tok.love, ['contact@neuf.com'])), { photos: {} });
});

test('photo de profil : types vérifiés sur les octets, taille limitée, remplacement', async () => {
  const t = await withTwo();
  assert.strictEqual((await t.put(t.tok.contact, EXE, 'image/jpeg')).status, 415, 'un exécutable déguisé en JPEG est refusé');
  assert.strictEqual((await t.put(t.tok.contact, Buffer.alloc(0))).status, 400);
  assert.strictEqual((await t.put(t.tok.contact, Buffer.concat([JPEG, Buffer.alloc(160 * 1024)]))).status, 413);
  assert.strictEqual((await t.put(t.tok.contact, PNG, 'text/html')).status, 200, 'le type vient des octets, pas de l’en-tête');
  assert.strictEqual((await t.get(t.tok.love, 'contact@neuf.com')).headers.get('content-type'), 'image/png');
  await t.put(t.tok.contact, JPEG);
  assert.strictEqual((await t.get(t.tok.love, 'contact@neuf.com')).headers.get('content-type'), 'image/jpeg');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM mailbox_photos')).n, 1);
});

test('photo de profil : jamais publique ; une boîte suspendue ou supprimée n’expose plus rien', async () => {
  const t = await withTwo();
  await t.put(t.tok.contact, JPEG);
  assert.strictEqual((await fetch(t.base + '/api/mail/photo/contact%40neuf.com')).status, 401, 'sans session');
  assert.strictEqual((await t.look('faux.jeton', ['contact@neuf.com'])).status, 401);
  assert.strictEqual((await t.user('/api/mail/photos', { method: 'POST', body: { addresses: ['contact@neuf.com'] } })).status, 401, 'un jeton de compte n’ouvre pas ces routes');
  await t.db.run("UPDATE mailboxes SET provider_status = 'suspended' WHERE local_part = 'contact'");
  assert.strictEqual((await t.get(t.tok.love, 'contact@neuf.com')).status, 404);
  assert.deepStrictEqual(await j(await t.look(t.tok.love, ['contact@neuf.com'])), { photos: {} });
  await t.db.run("UPDATE mailboxes SET provider_status = 'active' WHERE local_part = 'contact'");
  const id = (await t.db.get("SELECT id FROM mailboxes WHERE local_part = 'contact'")).id;
  await t.db.run('DELETE FROM mailboxes WHERE id = ?', id);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM mailbox_photos')).n, 0, 'supprimée avec la boîte');
});
