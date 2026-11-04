const test = require('node:test');
const assert = require('node:assert');
const { startKeepAlive } = require('../src/keepalive');
const { loadConfig } = require('../src/config');

test('auto-ping : désactivé sans adresse ; sinon appelle /api/health, ne plante jamais et signale les échecs', async () => {
  assert.strictEqual(startKeepAlive({}).enabled, false);
  const calls = [], logs = [];
  let mode = 'ok';
  const k = startKeepAlive({ url: 'https://api.exemple.com/', intervalMs: 3_600_000, log: (l, m, d) => logs.push([l, m, d]), fetchImpl: async (u, o) => { calls.push([u, o.headers['User-Agent']]); if (mode === 'throw') throw new Error('réseau'); return { ok: mode === 'ok', status: mode === 'ok' ? 200 : 503 }; } });
  assert.strictEqual(k.enabled, true);
  assert.strictEqual(await k.tick(), true);
  assert.deepStrictEqual(calls[0], ['https://api.exemple.com/api/health', 'freda-keepalive']);
  mode = 'down'; assert.strictEqual(await k.tick(), false);
  mode = 'throw'; assert.strictEqual(await k.tick(), false);
  assert.deepStrictEqual(logs.map((l) => l[1]), ['keepalive_unhealthy', 'keepalive_failed']);
  k.stop();
});

test('config auto-ping : adresse fournie par Render, désactivable (KEEP_ALIVE=false), adresse manuelle prioritaire', () => {
  const base = { NODE_ENV: 'development' };
  assert.strictEqual(loadConfig({ ...base }).keepAlive.url, '');
  assert.strictEqual(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://x.onrender.com' }).keepAlive.url, 'https://x.onrender.com');
  assert.strictEqual(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://x.onrender.com', KEEP_ALIVE: 'false' }).keepAlive.url, '');
  assert.strictEqual(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://x.onrender.com', KEEP_ALIVE_URL: 'https://fredaworkspace.com/api-host' }).keepAlive.url, 'https://fredaworkspace.com/api-host');
});
