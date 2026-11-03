const test = require('node:test');
const assert = require('node:assert');
const { createVault } = require('../src/vault');
const { loadConfig, assertSafe } = require('../src/config');

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
