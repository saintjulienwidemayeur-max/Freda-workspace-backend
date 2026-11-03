const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
const { signJwt } = require('../src/auth');
test.after(closeAll);

const jwtSetup = async () => (await setup({ env: { AUTH_MODE: 'jwt' } }));
const post = (t, path, body, headers = {}) => t.api(path, { method: 'POST', body, headers });
const signup = async (t, over = {}) => (await post(t, '/api/auth/signup', { name: 'Paul Test', email: 'Paul@Example.com', password: 'Motdepasse#2026', ...over })).json();

test('inscription : crée le compte, normalise l’e-mail, hache le mot de passe, envoie la bienvenue, renvoie un jeton utilisable', async () => {
  const t = await jwtSetup();
  const r = await post(t, '/api/auth/signup', { name: 'Paul Test', email: 'Paul@Example.com', password: 'Motdepasse#2026', phone: '37123456' });
  assert.strictEqual(r.status, 200);
  const s = await r.json();
  assert.strictEqual(s.user.email, 'paul@example.com');
  const row = await t.db.get('SELECT password_hash FROM users');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('Motdepasse'));
  assert.ok(t.mailer.sent.some((m) => /Bienvenue/.test(m.subject)));
  const me = await t.api('/api/me', { headers: { Authorization: 'Bearer ' + s.token } });
  assert.strictEqual((await me.json()).email, 'paul@example.com');
});

test('inscription : validations et doublon', async () => {
  const t = await jwtSetup();
  for (const b of [{ email: 'pas-un-email' }, { name: 'x' }, { password: 'court' }]) assert.strictEqual((await post(t, '/api/auth/signup', { name: 'Paul', email: 'a@b.co', password: 'Motdepasse#2026', ...b })).status, 400);
  await signup(t);
  assert.strictEqual((await post(t, '/api/auth/signup', { name: 'Autre', email: 'PAUL@example.com', password: 'Motdepasse#2026' })).status, 409);
});

test('connexion : bon mot de passe, mauvais mot de passe, compte inconnu (même message), limitation des essais', async () => {
  const t = await jwtSetup();
  await signup(t);
  assert.strictEqual((await post(t, '/api/auth/login', { email: 'paul@example.com', password: 'Motdepasse#2026' })).status, 200);
  const bad = await post(t, '/api/auth/login', { email: 'paul@example.com', password: 'faux' });
  const unknown = await post(t, '/api/auth/login', { email: 'nobody@example.com', password: 'faux' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual((await bad.json()).message, (await unknown.json()).message, 'ne révèle pas si le compte existe');
});

test('connexion : 8 échecs consécutifs bloquent les essais (429)', async () => {
  const t = await jwtSetup();
  await signup(t);
  let last;
  for (let i = 0; i < 9; i++) last = await post(t, '/api/auth/login', { email: 'paul@example.com', password: 'faux' + i });
  assert.strictEqual(last.status, 429);
  assert.strictEqual((await post(t, '/api/auth/login', { email: 'paul@example.com', password: 'Motdepasse#2026' })).status, 429, 'même le bon mot de passe est refusé pendant le blocage');
});

test('JWT : signature, expiration, alg=none, compte supprimé', async () => {
  const t = await jwtSetup();
  const s = await signup(t);
  const secret = t.cfg.auth.jwtSecret, now = Math.floor(Date.now() / 1000);
  const call = (token) => t.api('/api/me', { headers: { Authorization: token ? 'Bearer ' + token : '' } });
  assert.strictEqual((await call(s.token)).status, 200);
  assert.strictEqual((await call(signJwt({ sub: s.user.id, exp: now - 60 }, secret))).status, 401);
  assert.strictEqual((await call(signJwt({ sub: s.user.id, exp: now + 60 }, 'y'.repeat(40)))).status, 401);
  assert.strictEqual((await call(Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(`{"sub":"${s.user.id}"}`).toString('base64url') + '.')).status, 401);
  assert.strictEqual((await call('')).status, 401);
  assert.strictEqual((await call(signJwt({ sub: 'usr_inexistant', exp: now + 60 }, secret))).status, 401);
});

test('profil entreprise : PATCH /me/company enregistre les champs, e-mail de facturation validé, champs inconnus ignorés', async () => {
  const t = await jwtSetup();
  const s = await signup(t);
  const h = { Authorization: 'Bearer ' + s.token };
  const ok = await t.api('/api/me/company', { method: 'PATCH', headers: h, body: { company: 'Atelier Test', taxId: '123-456', address: '12 rue des Fleurs', city: 'Pétion-Ville', country: 'Haïti', billingEmail: 'compta@atelier.test', isAdmin: true, password_hash: 'x' } });
  assert.strictEqual(ok.status, 200);
  const u = await ok.json();
  assert.strictEqual(u.company, 'Atelier Test'); assert.strictEqual(u.taxId, '123-456');
  assert.strictEqual((await t.db.get('SELECT password_hash FROM users')).password_hash.startsWith('scrypt$'), true, 'champs sensibles non modifiables');
  assert.strictEqual((await t.api('/api/me/company', { method: 'PATCH', headers: h, body: { billingEmail: 'pas-un-email' } })).status, 400);
});

test('changement de mot de passe : exige l’ancien', async () => {
  const t = await jwtSetup();
  const s = await signup(t);
  const h = { Authorization: 'Bearer ' + s.token };
  assert.strictEqual((await post(t, '/api/me/password', { oldPassword: 'faux', newPassword: 'Nouveau#2026x' }, h)).status, 403);
  assert.strictEqual((await post(t, '/api/me/password', { oldPassword: 'Motdepasse#2026', newPassword: 'Nouveau#2026x' }, h)).status, 200);
  assert.strictEqual((await post(t, '/api/auth/login', { email: 'paul@example.com', password: 'Nouveau#2026x' })).status, 200);
});

test('réinitialisation : réponse identique pour un compte inconnu, jeton à usage unique, expiration', async () => {
  const t = await jwtSetup();
  await signup(t);
  const known = await post(t, '/api/auth/reset', { email: 'paul@example.com' });
  const unknown = await post(t, '/api/auth/reset', { email: 'nobody@example.com' });
  assert.deepStrictEqual(await known.json(), await unknown.json());
  const mail = t.mailer.sent.find((m) => /Réinitialisation/.test(m.subject));
  assert.ok(mail); assert.strictEqual(t.mailer.sent.filter((m) => /Réinitialisation/.test(m.subject)).length, 1);
  const token = /reset=([\w-]+)/.exec(mail.text)[1];
  assert.strictEqual((await post(t, '/api/auth/reset/confirm', { token, password: 'court' })).status, 400);
  const done = await post(t, '/api/auth/reset/confirm', { token, password: 'Reinit#2026ok' });
  assert.strictEqual(done.status, 200);
  assert.ok((await done.json()).token);
  assert.strictEqual((await post(t, '/api/auth/reset/confirm', { token, password: 'Autre#2026ok' })).status, 400, 'usage unique');
  assert.strictEqual((await post(t, '/api/auth/login', { email: 'paul@example.com', password: 'Reinit#2026ok' })).status, 200);
  await t.db.run('UPDATE password_resets SET used = 0, expires_at = 1');
  assert.strictEqual((await post(t, '/api/auth/reset/confirm', { token, password: 'Autre#2026ok' })).status, 400, 'expiré');
});

test('Google OAuth : crée le compte, rattache l’e-mail existant, refuse un état falsifié ; Apple non configuré', async () => {
  const t = await jwtSetup();
  const start = await t.api('/api/auth/oauth/google?next=espace/index.html', { redirect: 'manual' });
  assert.strictEqual(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.strictEqual(loc.searchParams.get('client_id'), 'gid');
  assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://api.test/api/auth/oauth/google/callback');
  const state = loc.searchParams.get('state');
  const cb = await t.api(`/api/auth/oauth/google/callback?code=good&state=${state}`, { redirect: 'manual' });
  assert.strictEqual(cb.status, 302);
  const dest = cb.headers.get('location');
  assert.match(dest, /^https:\/\/site\.test\/connexion\.html#token=[\w.-]+&next=espace%2Findex\.html&new=1$/);
  const token = /token=([\w.-]+)/.exec(dest)[1];
  assert.strictEqual((await (await t.api('/api/me', { headers: { Authorization: 'Bearer ' + token } })).json()).email, 'google.user@example.com');
  // deuxième connexion : même compte
  const again = await t.api(`/api/auth/oauth/google/callback?code=good&state=${new URL((await t.api('/api/auth/oauth/google', { redirect: 'manual' })).headers.get('location')).searchParams.get('state')}`, { redirect: 'manual' });
  assert.doesNotMatch(again.headers.get('location'), /new=1/);
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM users')).n, 1);
  const forged = await t.api('/api/auth/oauth/google/callback?code=good&state=forge', { redirect: 'manual' });
  assert.match(forged.headers.get('location'), /#error=invalid_state/);
  assert.strictEqual((await t.api('/api/auth/oauth/apple', { redirect: 'manual' })).status, 501);
});

test('moyens de paiement : MonCash/NatCash par numéro, masqué, défaut, suppression ; carte : enregistrement direct refusé (400)', async () => {
  const t = await setup();
  const add = (b) => t.user('/api/payment-methods', { method: 'POST', body: b });
  const a = await (await add({ type: 'moncash', phone: '37 12 34 56' })).json();
  assert.strictEqual(a.methods[0].phone, '+509 37•• ••56');
  assert.strictEqual(a.methods[0].default, true);
  assert.strictEqual((await add({ type: 'moncash', phone: '37123456' })).status, 409);
  assert.strictEqual((await add({ type: 'natcash', phone: '123' })).status, 400);
  assert.strictEqual((await add({ type: 'card', brand: 'Visa' })).status, 400);
  const b = await (await add({ type: 'natcash', phone: '48 00 11 22' })).json();
  const id2 = b.methods.find((m) => m.type === 'natcash').id;
  const def = await (await t.user('/api/payment-methods/' + id2, { method: 'PATCH' })).json();
  assert.strictEqual(def.methods.find((m) => m.id === id2).default, true);
  const del = await (await t.user('/api/payment-methods/' + id2, { method: 'DELETE' })).json();
  assert.strictEqual(del.methods.length, 1); assert.strictEqual(del.methods[0].default, true);
  assert.strictEqual((await t.as('autre@example.com')('/api/payment-methods/' + a.methods[0].id, { method: 'DELETE' })).status, 404, 'isolation entre comptes');
});

test('CORS : seules les origines autorisées ; corps JSON invalide / trop gros ; route inconnue', async () => {
  const t = await setup({ env: { ALLOWED_ORIGINS: 'https://fredaworkspace.com' } });
  assert.strictEqual((await fetch(t.base + '/api/health', { headers: { Origin: 'https://fredaworkspace.com' } })).headers.get('access-control-allow-origin'), 'https://fredaworkspace.com');
  assert.strictEqual((await fetch(t.base + '/api/health', { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);
  assert.strictEqual((await fetch(t.base + '/api/auth/login', { method: 'POST', body: '{pas json' })).status, 400);
  assert.strictEqual((await fetch(t.base + '/api/auth/login', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(40000) }) })).status, 413);
  assert.strictEqual((await t.api('/api/nope')).status, 404);
});

test('erreurs du frontend : /client-errors accepte et limite', async () => {
  const t = await setup();
  assert.strictEqual((await post(t, '/api/client-errors', { message: 'boom', page: '/index.html' })).status, 200);
});
