const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const j = (r) => r.json();
const sub = (t, body = {}) => t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', ...body } });
const modify = (t) => t.pm.calls.filter((c) => c.path.endsWith('/modifyUser'));
const run = (t) => t.app.app.jobs.run();

async function withMail(over = {}) {
  const t = await setup({ payments: demoPay, ...over });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  const first = await j(await sub(t, { domain: 'neuf.com', mailbox: { local: 'contact' } }));
  t.initialPassword = first.initialPassword;
  t.mailer.sent.length = 0;
  return t;
}
const boxStatus = (t) => t.db.get("SELECT provider_status AS s FROM mailboxes WHERE local_part = 'contact'").s;

test('impayée depuis plus de 7 jours : boîtes réellement suspendues (mot de passe aléatoire), messages conservés, client prévenu, une seule fois', async () => {
  const t = await withMail();
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9));
  await run(t);
  assert.strictEqual(t.db.get('SELECT status FROM subscriptions').status, 'suspended');
  assert.strictEqual(boxStatus(t), 'suspended');
  assert.strictEqual(modify(t).length, 1, 'UN seul appel : renommage + mot de passe');
  assert.strictEqual(modify(t)[0].body.userName, 'contact@neuf.com', 'adresse complète');
  assert.match(modify(t)[0].body.newUserName, /^susp-[0-9a-f]{10}@neuf\.com$/);
  assert.strictEqual(modify(t)[0].body.newPassword, undefined, 'le mot de passe choisi par le client n’est pas touché');
  assert.ok(!t.pm.calls.some((c) => c.path.endsWith('/deleteUser')), 'rien n’est supprimé');
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM mailboxes').n, 1, 'la boîte existe toujours');
  assert.strictEqual(t.mailer.sent.filter((m) => /suspendues/.test(m.subject)).length, 1);
  await run(t); await run(t);
  assert.strictEqual(modify(t).length, 1, 'pas de second appel');
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createRoutingRule')).length, 1, 'une seule règle de routage');
  assert.strictEqual(t.mailer.sent.filter((m) => /suspendues/.test(m.subject)).length, 1);
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'x', domain: 'neuf.com' } })).status, 402, 'pas de nouvelle boîte tant que suspendue');
});

test('suspension : plus AUCUN accès (mot de passe, mot de passe d’application, ancienne adresse) ; le courrier entrant est conservé', async () => {
  const t = await withMail();
  t.pmState.appPasswords['contact@neuf.com'] = ['app-secret'];
  assert.ok(t.pmState.login('contact@neuf.com', t.initialPassword) && t.pmState.login('contact@neuf.com', 'app-secret'), 'avant : les deux fonctionnent');
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await run(t);
  const renamed = t.pm.calls.find((c) => c.path.endsWith('/modifyUser')).body.newUserName;
  assert.ok(!t.pmState.login('contact@neuf.com', t.initialPassword), 'mot de passe principal refusé');
  assert.ok(!t.pmState.login('contact@neuf.com', 'app-secret'), 'mot de passe d’application refusé');
  assert.ok(!JSON.stringify(await (await t.user('/api/workspace')).json()).includes(renamed.split('@')[0]), 'le nouveau nom n’est jamais exposé au client');
  assert.strictEqual(t.pmState.deliver('contact@neuf.com'), renamed, 'le courrier entrant arrive dans la boîte conservée');
  assert.strictEqual(t.db.get('SELECT rule_state AS r FROM mailboxes').r, 'set');
});

test('mode « password » : seul le mot de passe change — le mot de passe d’application SURVIT (limite documentée, d’où le mode rename par défaut)', async () => {
  const t = await withMail({ env: { MAIL_SUSPEND_MODE: 'password' } });
  t.pmState.appPasswords['contact@neuf.com'] = ['app-secret'];
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await run(t);
  assert.strictEqual(modify(t)[0].body.newUserName, undefined);
  assert.ok(!t.pmState.login('contact@neuf.com', t.initialPassword));
  assert.ok(t.pmState.login('contact@neuf.com', 'app-secret'), 'limite connue du mode password');
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createRoutingRule')).length, 0);
});

test('suspension : règle de routage en échec -> boîte déjà verrouillée, règle retentée au passage suivant (courrier rejeté entre-temps)', async () => {
  const t = await withMail();
  t.pmState.failRules = true;
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await run(t);
  assert.strictEqual(boxStatus(t), 'suspended', 'l’accès est déjà bloqué');
  assert.strictEqual(t.db.get('SELECT rule_state AS r FROM mailboxes').r, 'pending');
  assert.strictEqual(t.pmState.deliver('contact@neuf.com'), null);
  t.pmState.failRules = false; await run(t);
  assert.strictEqual(t.db.get('SELECT rule_state AS r FROM mailboxes').r, 'set');
  assert.ok(t.pmState.deliver('contact@neuf.com'));
});

test('suspension : si Purelymail est en panne la boîte reste ouverte et la suspension est retentée au passage suivant', async () => {
  const t = await withMail();
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9));
  t.pmState.fail = true; await run(t);
  assert.strictEqual(boxStatus(t), 'active', 'échec : pas de faux « suspendu »');
  t.pmState.fail = false; await run(t);
  assert.strictEqual(boxStatus(t), 'suspended');
});

test('réactivation : le paiement rouvre les boîtes avec les MÊMES identifiants (aucun mot de passe renvoyé) ; les rappels repartent à zéro', async () => {
  const t = await withMail();
  t.db.run('UPDATE subscriptions SET renews_at = ?, notices = 7', days(-9)); await run(t);
  assert.strictEqual(boxStatus(t), 'suspended');
  assert.ok(!t.pmState.login('contact@neuf.com', t.initialPassword), 'suspendue : accès coupé');
  const before = modify(t).length;
  assert.strictEqual((await sub(t)).status, 200);
  assert.strictEqual(boxStatus(t), 'active');
  const reopen = modify(t)[before];
  assert.match(reopen.body.userName, /^susp-/); assert.strictEqual(reopen.body.newUserName, 'contact@neuf.com');
  assert.strictEqual(reopen.body.newPassword, undefined, 'aucun nouveau mot de passe');
  assert.ok(t.pmState.users.includes('contact@neuf.com') && !t.pmState.users.some((u) => u.startsWith('susp-')), 'ancien nom rétabli');
  assert.strictEqual(t.pmState.rules.length, 0, 'règle de suspension retirée');
  assert.strictEqual(t.pmState.deliver('contact@neuf.com'), 'contact@neuf.com');
  assert.ok(t.pmState.login('contact@neuf.com', t.initialPassword), 'son mot de passe d’origine refonctionne');
  const mail = t.mailer.sent.find((m) => /réactivées/.test(m.subject));
  assert.ok(mail && /mêmes identifiants/.test(mail.text) && /n'a pas changé/.test(mail.text) && !mail.text.includes(t.initialPassword), 'e-mail sans mot de passe');
  const s = t.db.get('SELECT * FROM subscriptions');
  assert.deepStrictEqual([s.status, s.notices, s.cancel_at_period_end], ['active', 0, 0]);
  assert.strictEqual(t.db.get('SELECT rule_state AS r, provider_user AS u FROM mailboxes').r, '');
});

test('mode « password » : réactivation = NOUVEAU mot de passe envoyé par e-mail (l’ancien avait été remplacé)', async () => {
  const t = await withMail({ env: { MAIL_SUSPEND_MODE: 'password' } });
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await run(t);
  const before = modify(t).length;
  await sub(t);
  const reopen = modify(t)[before];
  assert.ok(t.mailer.sent.find((m) => /réactivées/.test(m.subject)).text.includes('contact@neuf.com : ' + reopen.body.newPassword));
  assert.ok(t.pmState.login('contact@neuf.com', reopen.body.newPassword));
});

test('réactivation : boîte en échec chez Purelymail -> reste suspendue (pas de faux « actif ») et alerte', async () => {
  const alerts = [];
  const t = await withMail({ deps: { alert: async (...a) => alerts.push(a) } });
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await run(t);
  t.pmState.fail = true; await sub(t); t.pmState.fail = false;
  assert.strictEqual(boxStatus(t), 'suspended');
  assert.ok(alerts.some((a) => /non réactivées/.test(a[1])));
});

test('résiliation : active jusqu’à la fin de la période, aucun rappel ni prélèvement, puis boîtes suspendues ; reprise possible avant la fin', async () => {
  const t = await withMail();
  const r = await t.user('/api/subscription/cancel', { method: 'POST' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await j(r)).cancelAtPeriodEnd, true);
  assert.strictEqual((await t.user('/api/subscription/cancel', { method: 'POST' })).status, 200, 'idempotent');
  assert.strictEqual((await j(await t.user('/api/workspace'))).plan.cancelAtPeriodEnd, true);
  assert.ok(t.mailer.sent.some((m) => /résiliée/.test(m.subject)));
  t.mailer.sent.length = 0;
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(2)); await run(t);
  assert.strictEqual(t.mailer.sent.length, 0, 'pas de rappel de renouvellement');
  assert.strictEqual(boxStatus(t), 'active', 'toujours utilisable jusqu’à la fin');
  const back = await t.user('/api/subscription/resume', { method: 'POST' });
  assert.strictEqual((await j(back)).cancelAtPeriodEnd, false);
  await t.user('/api/subscription/cancel', { method: 'POST' });
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-1)); await run(t);
  const s = t.db.get('SELECT status FROM subscriptions').status;
  assert.strictEqual(s, 'cancelled', 'pas « past_due »');
  assert.strictEqual(boxStatus(t), 'suspended');
  assert.strictEqual((await t.user('/api/subscription/resume', { method: 'POST' })).status, 409, 'trop tard : se réabonner');
  assert.strictEqual((await sub(t)).status, 200, 'se réabonner rouvre les boîtes');
  assert.strictEqual(boxStatus(t), 'active');
});

test('résiliation : aucune offre -> 404 ; chaque compte ne touche que sa propre offre', async () => {
  const t = await withMail();
  assert.strictEqual((await t.as('autre@example.com')('/api/subscription/cancel', { method: 'POST' })).status, 404);
  assert.strictEqual(t.db.get('SELECT cancel_at_period_end AS c FROM subscriptions').c, 0);
});

test('résiliation avec carte enregistrée : plus aucun prélèvement à l’échéance (Stripe)', async () => {
  const t = await setup({ env: { PAYMENTS_PROVIDER: 'paym' }, stripe: true });
  const first = await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1, method: 'card' } });
  const r = await j(first);
  t.stState.sessions[t.db.get('SELECT charge_id FROM orders').charge_id].payment_status = 'paid';
  t.db.run('UPDATE orders SET last_check = 0'); await t.user('/api/orders/' + r.orderId);
  const methodId = (await j(await t.user('/api/payment-methods'))).methods[0].id;
  await sub(t, { method: 'card', methodId });
  await t.user('/api/subscription/cancel', { method: 'POST' });
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-1));
  const n = t.stripe.calls.filter((c) => c.path === '/v1/payment_intents').length;
  await run(t);
  assert.strictEqual(t.stripe.calls.filter((c) => c.path === '/v1/payment_intents').length, n, 'aucun prélèvement');
});

test('suppression d’une boîte suspendue : supprimée aussi chez Purelymail', async () => {
  const t = await withMail();
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(-9)); await run(t);
  const id = t.db.get('SELECT id FROM mailboxes').id;
  assert.strictEqual((await t.user('/api/mailboxes/' + id, { method: 'DELETE' })).status, 200);
  const del = t.pm.calls.find((c) => c.path.endsWith('/deleteUser'));
  assert.match(del.body.userName, /^susp-[0-9a-f]{10}@neuf\.com$/, 'supprimée sous son nom actuel');
  assert.strictEqual(t.pmState.rules.length, 0, 'règle de suspension retirée');
  assert.strictEqual(t.pmState.users.length, 0);
});

test('régression : les rappels du cycle suivant ne sont plus étouffés (notices remis à zéro à chaque renouvellement)', async () => {
  const t = await withMail();
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(4)); await run(t);
  assert.ok(t.mailer.sent.some((m) => /se renouvelle dans/.test(m.subject)));
  await sub(t, { renewal: true });
  assert.strictEqual(t.db.get('SELECT notices FROM subscriptions').notices, 0);
  t.mailer.sent.length = 0;
  t.db.run('UPDATE subscriptions SET renews_at = ?', days(4)); await run(t);
  assert.ok(t.mailer.sent.some((m) => /se renouvelle dans/.test(m.subject)), 'rappel du 2e cycle envoyé');
});
