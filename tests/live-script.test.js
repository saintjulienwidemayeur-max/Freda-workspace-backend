const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'purelymail-live-check.js');
const run = (t, args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, PURELYMAIL_API_KEY: 'pm-key', PURELYMAIL_BASE_URL: t.pm.url, PURELYMAIL_TEST_DOMAIN: 'test.example',
      IMAP_HOST: '127.0.0.1', IMAP_PORT: String(t.imap.port), IMAP_SECURE: 'false', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(t.smtp.port), SMTP_SECURE: 'false', ...env },
    timeout: 60000,
  }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
});

test('script de test réel : tout réussit contre un serveur conforme, la boîte jetable est supprimée, aucun mot de passe affiché', async () => {
  const t = await setup({});
  t.pmState.domains.push('test.example');
  const r = await run(t, ['--yes', '--deliver']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual((r.out.match(/^PASS /gm) || []).length, 10, r.out);
  assert.ok(!/FAIL/.test(r.out));
  assert.match(r.out, /Toutes les vérifications ont réussi/);
  assert.strictEqual(t.pmState.users.length, 0, 'boîte jetable supprimée');
  assert.strictEqual(t.pmState.rules.length, 0, 'règle supprimée');
  assert.ok(!/Test-[0-9a-f]{20}/.test(r.out), 'aucun mot de passe dans la sortie');
  assert.ok(!t.pm.calls.some((c) => /userName":"(?!fredatest-|susp-)/.test(JSON.stringify(c.body)) && c.path.match(/deleteUser|modifyUser/)), 'ne touche que sa propre boîte');
});

test('script de test réel : un renommage qui ne bloque pas l’ancienne adresse est détecté (FAIL, code 1) et le nettoyage a quand même lieu', async () => {
  const t = await setup({});
  t.pmState.domains.push('test.example'); t.pmState.keepOldName = true;
  const r = await run(t, ['--yes']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /FAIL .*suspension par renommage/);
  assert.strictEqual(t.pmState.users.length, 0, 'nettoyage garanti malgré l’échec');
  assert.strictEqual(t.pmState.rules.length, 0);
});

test('script de test réel : livraison impossible vers la boîte renommée -> FAIL ; domaine absent du compte -> arrêt sans rien créer ; sans --yes -> refus', async () => {
  const t = await setup({});
  t.pmState.domains.push('test.example');
  t.pmState.noRuleDelivery = true;
  const orig = t.pmState.deliver; t.pmState.deliver = (a) => (a.startsWith('fredatest-') ? null : orig(a));   // la règle ne livre pas
  const bad = await run(t, ['--yes', '--deliver']);
  assert.strictEqual(bad.code, 1, bad.out); assert.match(bad.out, /FAIL .*arrive dans la boîte renommée/);
  assert.strictEqual(t.pmState.users.length, 0);
  const t2 = await setup({});
  const none = await run(t2, ['--yes']);
  assert.strictEqual(none.code, 1); assert.match(none.out, /n’est pas dans votre compte/);
  assert.ok(!t2.pm.calls.some((c) => c.path.endsWith('/createUser')), 'rien créé');
  const refuse = await run(t2, []);
  assert.strictEqual(refuse.code, 2); assert.match(refuse.out, /Usage/);
});
