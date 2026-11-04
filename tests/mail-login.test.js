const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
const { imapLogin } = require('../src/imap');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const j = (r) => r.json();
const PW = 'MonMotDePasse!2026';

async function withMail(mailbox = { local: 'contact', password: PW }, over = {}) {
  const t = await setup({ payments: demoPay, ...over });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  const r = await j(await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'neuf.com', mailbox } }));
  t.checkout = r;
  t.login = (email, password, headers) => t.api('/api/mail/login', { method: 'POST', body: { email, password }, headers });
  return t;
}

test('mot de passe CHOISI par le client à l’achat : appliqué chez Purelymail, jamais renvoyé, jamais envoyé par e-mail, jamais stocké (même chiffré après exécution)', async () => {
  const t = await withMail();
  assert.strictEqual(t.checkout.initialPassword, undefined, 'rien à renvoyer : le client le connaît');
  assert.strictEqual(t.pm.calls.find((c) => c.path.endsWith('/createUser')).body.password, PW);
  assert.ok(t.pmState.login('contact@neuf.com', PW));
  assert.ok(!t.mailer.sent.some((m) => m.text.includes(PW)), 'jamais par e-mail');
  const welcome = t.mailer.sent.find((m) => /première boîte/.test(m.subject));
  assert.ok(welcome && /application/i.test(welcome.text) && !welcome.text.includes('Mot de passe initial'));
  assert.ok(!JSON.stringify(await t.db.all('SELECT * FROM orders')).includes('passwordEnc'), 'plus aucune trace, même chiffrée');
  assert.ok(!JSON.stringify((await t.db.all('SELECT * FROM orders')) .concat(await t.db.all('SELECT * FROM mailboxes'))).includes(PW));
});

test('mot de passe trop court / identique à l’adresse : refusé AVANT tout paiement', async () => {
  const t = await setup({ payments: demoPay });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  for (const password of ['court', 'contact', 'x'.repeat(129)]) {
    const r = await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact', password } } });
    assert.strictEqual(r.status, 400); assert.strictEqual((await j(r)).code, 'weak_password');
  }
  assert.strictEqual((await t.db.get("SELECT COUNT(*) AS n FROM orders WHERE kind = 'subscription'")).n, 0, 'aucune commande, aucun débit');
});

test('commande échouée : le mot de passe chiffré est purgé par le balayage', async () => {
  const t = await setup({ env: { PAYMENTS_PROVIDER: 'paym' } });
  const d = await j(await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'moncash' } }));
  t.state.paid.add(d.reference); await t.db.run('UPDATE orders SET last_check = 0'); await t.user('/api/orders/' + d.orderId);
  const r = await j(await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', method: 'moncash', domain: 'neuf.com', mailbox: { local: 'contact', password: PW } } }));
  assert.ok(JSON.stringify(await t.db.all('SELECT payload FROM orders')).includes('passwordEnc'), 'conservé chiffré tant que le paiement est attendu');
  await t.db.run("UPDATE orders SET status = 'expired' WHERE id = ?", r.orderId);
  await t.app.app.jobs.run();
  assert.ok(!JSON.stringify(await t.db.all('SELECT payload FROM orders')).includes('passwordEnc'));
});

test('création de boîte par le titulaire avec un mot de passe choisi ; sans mot de passe, un mot de passe initial est généré (compatibilité)', async () => {
  const t = await withMail();
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly' } });
  const a = await j(await t.user('/api/mailboxes', { method: 'POST', body: { local: 'ventes', domain: 'neuf.com', password: 'AutreMotDePasse#1' } }));
  assert.strictEqual(a.initialPassword, null);
  assert.ok(t.pmState.login('ventes@neuf.com', 'AutreMotDePasse#1'));
  const b = await j(await t.user('/api/mailboxes', { method: 'POST', body: { local: 'compta', domain: 'neuf.com' } }));
  assert.ok(b.initialPassword && t.pmState.login('compta@neuf.com', b.initialPassword));
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'rh', domain: 'neuf.com', password: 'court' } })).status, 400);
});

test('connexion de l’app : adresse pro + mot de passe de la boîte vérifiés par IMAP ; réponse = état + réglages IMAP/SMTP, aucun secret', async () => {
  const t = await withMail();
  const r = await t.login('Contact@Neuf.com', PW);
  assert.strictEqual(r.status, 200);
  const out = await j(r);
  assert.deepStrictEqual(out.mailbox, { address: 'contact@neuf.com', name: 'contact', status: 'active' });
  assert.strictEqual(out.imap.host, 'imap.purelymail.com'); assert.strictEqual(out.smtp.port, 465);
  assert.ok(!JSON.stringify(out).includes(PW));
  assert.deepStrictEqual(t.imap.calls.pop(), { user: 'contact@neuf.com', pass: PW });
  assert.ok((await t.db.get('SELECT last_login FROM mailboxes')).last_login);
});

test('connexion de l’app : mauvais mot de passe / adresse inconnue -> même 401 ; adresse inconnue : aucun appel IMAP', async () => {
  const t = await withMail();
  const bad = await t.login('contact@neuf.com', 'FauxMotDePasse!1');
  assert.strictEqual(bad.status, 401);
  const unknown = await t.login('inconnu@neuf.com', PW);
  assert.strictEqual(unknown.status, 401);
  assert.deepStrictEqual(await j(bad), await j(unknown), 'même réponse : aucune fuite sur l’existence de la boîte');
  assert.strictEqual(t.imap.calls.length, 1, 'seule l’adresse connue a été vérifiée chez Purelymail');
  for (const body of [{}, { email: 'pas-une-adresse', password: PW }, { email: 'contact@neuf.com' }, { email: 'contact@neuf.com', password: 123 }]) assert.strictEqual((await t.api('/api/mail/login', { method: 'POST', body })).status, 401);
});

test('connexion de l’app : 5 mots de passe faux par adresse -> 429 ; le bon mot de passe est alors refusé aussi (anti force brute)', async () => {
  const t = await withMail();
  for (let i = 0; i < 5; i++) assert.strictEqual((await t.login('contact@neuf.com', 'Faux-' + i + '-motdepasse')).status, 401);
  assert.strictEqual((await t.login('contact@neuf.com', PW)).status, 429);
  assert.strictEqual(t.imap.calls.length, 5, 'plus aucun appel vers Purelymail pendant le blocage');
});

test('connexion de l’app : le champ peut s’appeler email, address ou username (même résultat)', async () => {
  const t = await withMail();
  for (const field of ['email', 'address', 'username']) {
    const r = await t.api('/api/mail/login', { method: 'POST', body: { [field]: 'contact@neuf.com', password: PW } });
    assert.strictEqual(r.status, 200, field);
  }
});

test('connexion de l’app : une rafale PARALLÈLE de mots de passe faux ne dépasse pas la limite (compteur réservé avant la vérification IMAP)', async () => {
  const t = await withMail();
  const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => t.api('/api/mail/login', { method: 'POST', body: { email: 'contact@neuf.com', password: 'Faux-' + i + '-motdepasse' }, headers: { 'X-Forwarded-For': '10.0.0.' + i } })));
  assert.ok(t.imap.calls.length <= 5, `au plus 5 vérifications chez Purelymail, obtenu ${t.imap.calls.length}`);
  assert.strictEqual(rs.filter((r) => r.status === 429).length, 14 - t.imap.calls.length);
});

test('connexion de l’app : un succès remet le compteur d’échecs à zéro', async () => {
  const t = await withMail();
  for (let i = 0; i < 4; i++) await t.login('contact@neuf.com', 'Faux-' + i + '-motdepasse');
  assert.strictEqual((await t.login('contact@neuf.com', PW)).status, 200);
  for (let i = 0; i < 4; i++) assert.strictEqual((await t.login('contact@neuf.com', 'Faux-' + i + '-motdepasse')).status, 401);
});

test('connexion de l’app : abonnement suspendu / résilié -> 402 « abonnement inactif » ; réactivé -> mêmes identifiants refonctionnent', async () => {
  const t = await withMail();
  await t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await t.app.app.jobs.run();
  const r = await t.login('contact@neuf.com', PW);
  assert.strictEqual(r.status, 402); assert.strictEqual((await j(r)).code, 'subscription_inactive');
  assert.strictEqual(t.imap.calls.length, 0, 'pas d’appel IMAP pour une boîte suspendue');
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly' } });
  assert.strictEqual((await t.login('contact@neuf.com', PW)).status, 200);
});

test('connexion de l’app : IMAP injoignable -> 503 (jamais « mot de passe incorrect »), et ne compte pas comme un échec', async () => {
  const t = await withMail();
  t.pmState.imapDown = true;
  for (let i = 0; i < 6; i++) assert.strictEqual((await t.login('contact@neuf.com', PW)).status, 503);
  t.pmState.imapDown = false;
  assert.strictEqual((await t.login('contact@neuf.com', PW)).status, 200);
});

test('connexion de l’app : boîte en cours d’activation -> 503 explicite', async () => {
  const t = await withMail();
  await t.db.run("UPDATE mailboxes SET provider_status = 'pending_provider'");
  assert.strictEqual((await j(await t.login('contact@neuf.com', PW))).code, 'mailbox_not_ready');
});

test('changement de mot de passe de la boîte par le titulaire du compte : appliqué chez Purelymail, ancien refusé, règles de longueur, isolation entre comptes', async () => {
  const t = await withMail();
  const id = (await t.db.get('SELECT id FROM mailboxes')).id;
  const NEW = 'NouveauMotDePasse$77';
  assert.strictEqual((await t.as('autre@example.com')(`/api/mailboxes/${id}/password`, { method: 'POST', body: { password: NEW } })).status, 404);
  assert.strictEqual((await t.user(`/api/mailboxes/${id}/password`, { method: 'POST', body: { password: 'court' } })).status, 400);
  assert.strictEqual((await t.user(`/api/mailboxes/${id}/password`, { method: 'POST', body: { password: NEW } })).status, 200);
  assert.deepStrictEqual(t.pm.calls.filter((c) => c.path.endsWith('/modifyUser')).pop().body, { userName: 'contact@neuf.com', newPassword: NEW });
  assert.strictEqual((await t.login('contact@neuf.com', PW)).status, 401, 'ancien refusé');
  assert.strictEqual((await t.login('contact@neuf.com', NEW)).status, 200);
  assert.strictEqual((await t.api(`/api/mailboxes/${id}/password`, { method: 'POST', body: { password: NEW } })).status, 401, 'authentification requise');
});

test('client IMAP : refus, succès, protocole inattendu, injection (caractères de contrôle) et serveur muet', async () => {
  const t = await withMail();
  const base = { host: '127.0.0.1', port: t.imap.port, secure: false };
  assert.strictEqual(await imapLogin({ ...base, user: 'contact@neuf.com', pass: PW }), 'ok');
  assert.strictEqual(await imapLogin({ ...base, user: 'contact@neuf.com', pass: 'nope' }), 'denied');
  assert.strictEqual(await imapLogin({ ...base, user: 'a\r\nb LOGOUT', pass: PW }), 'denied', 'pas d’injection de commande');
  assert.strictEqual(await imapLogin({ ...base, user: 'contact@neuf.com', pass: 'a\0b' }), 'denied');
  await assert.rejects(imapLogin({ host: '127.0.0.1', port: 1, secure: false, user: 'x@y.z', pass: 'p', timeoutMs: 500 }));
});
