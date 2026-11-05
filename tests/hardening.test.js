const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
const { createMailer, templates } = require('../src/mailer');
test.after(closeAll);

const TOKEN = 'a'.repeat(32);
const adm = (t, path, opts = {}) => t.api(path, { ...opts, headers: { Authorization: 'Bearer ' + (opts.token || TOKEN), ...(opts.headers || {}) } });

test('jeton admin : 8 échecs par IP bloquent l’IP (429) ; l’IP client est lue à droite de X-Forwarded-For (non falsifiable)', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  // un client qui falsifie la première entrée ne change pas son IP réelle (la dernière entrée est celle du proxy)
  for (let i = 0; i < 8; i++) assert.strictEqual((await adm(t, '/api/admin/rate', { token: 'faux-' + i, headers: { 'X-Forwarded-For': `1.2.3.${i}, 9.9.9.9` } })).status, 401);
  assert.strictEqual((await adm(t, '/api/admin/rate', { token: 'faux-x', headers: { 'X-Forwarded-For': '8.8.4.4, 9.9.9.9' } })).status, 429, 'même IP réelle : bloquée malgré l’en-tête falsifié');
  assert.strictEqual((await adm(t, '/api/admin/rate', { headers: { 'X-Forwarded-For': '8.8.4.4, 7.7.7.7' } })).status, 200, 'une autre IP réelle n’est pas touchée');
});

test('taux HTG : lecture avec défaut, validation 50-1000, enregistrement et retour au défaut', async () => {
  const t = await setup({ env: { ADMIN_TOKEN: TOKEN } });
  const g = await (await adm(t, '/api/admin/rate')).json();
  assert.deepStrictEqual([g.htgRate, g.defaultRate], [132, 132]);
  for (const bad of [0, 10, 5000, 'abc', null]) assert.strictEqual((await adm(t, '/api/admin/rate', { method: 'PUT', body: { htgRate: bad } })).status, 400);
  assert.strictEqual((await adm(t, '/api/admin/rate', { method: 'PUT', body: { htgRate: 140.5 } })).status, 200);
  assert.strictEqual((await (await adm(t, '/api/admin/rate')).json()).htgRate, 140.5);
  assert.strictEqual((await (await t.api('/api/plans')).json()).htgRate, 140.5, 'le site lit le taux');
  assert.strictEqual((await (await adm(t, '/api/admin/rate', { method: 'PUT', body: { reset: true } })).json()).htgRate, 132);
});

test('changement de mot de passe : les anciens jetons sont révoqués, le nouveau fonctionne', async () => {
  const t = await setup({ env: { AUTH_MODE: 'jwt' } });
  const s = await (await t.api('/api/auth/signup', { method: 'POST', body: { name: 'Paul Test', email: 'paul@example.com', password: 'Motdepasse#2026' } })).json();
  const me = (token) => t.api('/api/me', { headers: { Authorization: 'Bearer ' + token } });
  assert.strictEqual((await me(s.token)).status, 200);
  const r = await (await t.api('/api/me/password', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token }, body: { oldPassword: 'Motdepasse#2026', newPassword: 'Nouveau#Motdepasse9' } })).json();
  assert.ok(r.token, 'une nouvelle session est renvoyée');
  assert.strictEqual((await me(s.token)).status, 401, 'ancien jeton révoqué');
  assert.strictEqual((await me(r.token)).status, 200, 'nouveau jeton valide');
});

test('devis : le .ht n’est jamais vendu ; un domaine absent des listes du registraire donne 502 (réessayez), pas « indisponible »', async () => {
  const t = await setup({ env: { DOMAIN_TLDS: '.com,.net,.ht' } });
  const r = await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', method: 'moncash', domains: ['monsite.ht'], years: 1 } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).code, 'tld_coming_soon');
});

test('commande bloquée en exécution : le balayage la passe en « needs_attention » avec alerte', async () => {
  const t = await setup({});
  const u = await t.db.get("SELECT id FROM users LIMIT 1") || null;
  const uid = u ? u.id : 'u1';
  if (!u) await t.db.run('INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)', uid, 'a@b.co', 'A', new Date().toISOString());
  const old = new Date(Date.now() - 30 * 60_000).toISOString();
  await t.db.run("INSERT INTO orders (id, user_id, reference, kind, status, amount, created_at, updated_at, last_check) VALUES (?,?,?,?,?,?,?,?,?)", 'o_stuck', uid, 'FP-STUCK', 'domain', 'fulfilling', 12.99, old, old, 0);
  await t.app.app.orders.sweep();
  assert.strictEqual((await t.db.get("SELECT status FROM orders WHERE id = 'o_stuck'")).status, 'needs_attention');
});

test('e-mails : le mot de passe n’apparaît jamais dans l’aperçu caché ; nom piégé ni lien ni bouton ; bouton selon l’URL', async () => {
  const m = createMailer({ mailer: { provider: 'console' } }, () => {});
  await m.send({ to: 'a@b.c', subject: 'Votre première boîte mail', text: 'Bonjour Jean,\n\nVotre boîte contact@x.com est prête.\nMot de passe initial : Xk9#mQ2vLp\n\nChangez-le dès la première connexion.' });
  const pre = /<div style="display:none[^>]*>([^<]*)/.exec(m.sent[0].html)[1];
  assert.ok(!pre.includes('Xk9'), 'aucun secret dans l’aperçu');
  assert.ok(m.sent[0].html.includes('Xk9#mQ2vLp'), 'le mot de passe reste dans le corps');
  await m.send({ to: 'a@b.c', ...templates.welcome({ name: 'Eve\n\nhttps://evil.example/phish' }, 'https://fredaworkspace.com') });
  assert.ok(!/evil\.example/.test(m.sent[1].html) && !/evil\.example/.test(m.sent[1].text), 'URL retirée du nom');
  await m.send({ to: 'a@b.c', ...templates.subscriptionDue({ name: 'Jean' }, 'Starter', 3, 'https://fredaworkspace.com/espace/facturation.html?renew=1') });
  assert.ok(!/Renouveler mon domaine/.test(m.sent[2].html), 'bouton d’abonnement ≠ bouton de domaine');
});

test('inscription : lien de confirmation, achats bloqués tant que l’adresse n’est pas vérifiée, lien à usage unique', async () => {
  const t = await setup({ env: { AUTH_MODE: 'jwt' } });
  const s = await (await t.api('/api/auth/signup', { method: 'POST', body: { name: 'Paul Test', email: 'paul@example.com', password: 'Motdepasse#2026' } })).json();
  assert.strictEqual(s.user.emailVerified, false);
  const mail = t.mailer.sent.find((m) => /Confirmez votre adresse/.test(m.subject));
  assert.ok(mail, 'e-mail de confirmation envoyé');
  const token = /verify=([\w-]+)/.exec(mail.text)[1];
  const auth = { Authorization: 'Bearer ' + s.token };
  const buy = () => t.api('/api/checkout', { method: 'POST', headers: auth, body: { kind: 'topup', amount: 10, method: 'moncash' } });
  const blocked = await buy();
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual((await blocked.json()).code, 'email_not_verified');
  assert.strictEqual((await t.api('/api/mailboxes', { method: 'POST', headers: auth, body: { local: 'contact', domain: 'x.com', name: 'A', password: 'Motdepasse#2026' } })).status, 403);
  assert.strictEqual((await t.api('/api/auth/verify', { method: 'POST', body: { token: 'faux' } })).status, 400);
  assert.strictEqual((await t.api('/api/auth/verify', { method: 'POST', body: { token } })).status, 200);
  assert.strictEqual((await t.api('/api/auth/verify', { method: 'POST', body: { token } })).status, 400, 'usage unique');
  assert.strictEqual((await (await t.api('/api/me', { headers: auth })).json()).emailVerified, true);
  assert.notStrictEqual((await buy()).status, 403, 'achat autorisé après confirmation');
  const r = await t.api('/api/auth/verify/resend', { method: 'POST', headers: auth });
  assert.strictEqual((await r.json()).alreadyVerified, true);
});
