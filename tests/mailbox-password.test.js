const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
const { hashPassword } = require('../src/auth');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const PW = 'MonMotDePasse!2026';
const j = (r) => r.json();

async function withBox(over = {}) {
  const t = await setup({ payments: demoPay, ...over });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } });
  t.boxId = async (local = 'contact') => (await t.db.get('SELECT id FROM mailboxes WHERE local_part = ?', local)).id;
  t.reveal = async (id, password, as) => (as || t.user)(`/api/mailboxes/${id}/reveal-password`, { method: 'POST', body: password === undefined ? {} : { password } });
  return t;
}

test('mot de passe choisi à la création : conservé chiffré, revu par le titulaire ; la liste dit seulement « conservé »', async () => {
  const t = await withBox();
  const id = await t.boxId();
  const r = await t.reveal(id);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await j(r), { address: 'contact@neuf.com', password: PW });
  assert.ok(!JSON.stringify(await t.db.all('SELECT password_enc FROM mailboxes')).includes(PW), 'jamais en clair en base');
  const list = await j(await t.user('/api/mailboxes'));
  assert.strictEqual(list.mailboxes[0].passwordStored, true);
  assert.ok(!JSON.stringify(list).includes(PW), 'la liste ne contient jamais le mot de passe');
});

test('mot de passe généré (boîte créée sans choix) : le même est revu', async () => {
  const t = await withBox();
  const r = await j(await t.user('/api/mailboxes', { method: 'POST', body: { local: 'ventes', domain: 'neuf.com' } }));
  assert.ok(r.initialPassword, r.message);
  assert.strictEqual((await j(await t.reveal(r.mailbox.id))).password, r.initialPassword);
});

test('changement de mot de passe : le nouveau est revu', async () => {
  const t = await withBox();
  const id = await t.boxId();
  assert.strictEqual((await t.user(`/api/mailboxes/${id}/password`, { method: 'POST', body: { password: 'Nouveau-Mot-De-Passe-2027' } })).status, 200);
  assert.strictEqual((await j(await t.reveal(id))).password, 'Nouveau-Mot-De-Passe-2027');
});

test('compte avec mot de passe : il faut le ressaisir ; mauvais = 403 sans fuite ; 5 erreurs = blocage 429 même avec le bon', async () => {
  const t = await withBox();
  const id = await t.boxId();
  await t.db.run("UPDATE users SET password_hash = ? WHERE email = 'paul@example.com'", hashPassword('Secret-Du-Compte-1'));
  assert.strictEqual((await t.reveal(id)).status, 403, 'sans mot de passe de compte');
  const bad = await t.reveal(id, 'faux');
  assert.strictEqual(bad.status, 403); assert.ok(!JSON.stringify(await j(bad)).includes(PW));
  assert.strictEqual((await t.reveal(id, 'Secret-Du-Compte-1')).status, 200, 'le bon passe (compteur remis à zéro)');
  for (let i = 0; i < 5; i++) assert.strictEqual((await t.reveal(id, 'faux' + i)).status, 403);
  const blocked = await t.reveal(id, 'Secret-Du-Compte-1');
  assert.strictEqual(blocked.status, 429);
});

test('boîte d’un autre compte : 404 ; non authentifié : 401 ; boîte suspendue : 409 ; ancienne boîte sans mot de passe conservé : 404 password_unknown', async () => {
  const t = await withBox();
  const id = await t.boxId();
  assert.strictEqual((await t.api(`/api/mailboxes/${id}/reveal-password`, { method: 'POST', body: {} })).status, 401);
  assert.strictEqual((await t.reveal(id, undefined, t.as('autre@example.com'))).status, 404);
  await t.db.run("UPDATE mailboxes SET password_enc = ''");
  const old = await t.reveal(id);
  assert.strictEqual(old.status, 404); assert.strictEqual((await j(old)).code, 'password_unknown');
  assert.strictEqual((await j(await t.user('/api/mailboxes'))).mailboxes[0].passwordStored, false);
  await t.db.run("UPDATE mailboxes SET provider_status = 'suspended'");
  assert.strictEqual((await t.reveal(id)).status, 409);
});

test('suspension en mode « password » : l’ancien mot de passe n’est plus conservé ; la réactivation conserve le nouveau', async () => {
  const t = await withBox({ env: { MAIL_SUSPEND_MODE: 'password' } });
  const id = await t.boxId();
  await t.app.app.mail.suspendMailboxes((await t.db.get('SELECT user_id FROM mailboxes WHERE id = ?', id)).user_id);
  assert.strictEqual((await t.db.get('SELECT password_enc FROM mailboxes WHERE id = ?', id)).password_enc, '');
  const re = await t.app.app.mail.reactivateMailboxes((await t.db.get('SELECT user_id FROM mailboxes WHERE id = ?', id)).user_id);
  assert.strictEqual(re.mailboxes.length, 1);
  assert.strictEqual((await j(await t.reveal(id))).password, re.mailboxes[0].password);
});
