const test = require('node:test');
const assert = require('node:assert');
const { setup, closeAll } = require('./helpers');
test.after(closeAll);

const demoPay = { name: 'test', async create() { return { status: 'paid', providerRef: 'x' }; }, async verify() { return { status: 'paid' }; }, async refund() {} };
const j = async (r) => r.json();

/** Compte avec un domaine acheté chez nous (zone gérée par NameSilo) et une offre active. */
async function withDomain(over = {}) {
  const t = await setup({ payments: demoPay, ...over });
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  return t;
}
const withMail = async () => {
  const t = await withDomain();
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact' } } });
  return t;
};

test('DNS : ajout, modification, suppression répercutés chez NameSilo (hôte relatif, @ = racine, nouvel id après update)', async () => {
  const t = await withDomain();
  const add = await t.user('/api/domains/neuf.com/dns', { method: 'POST', body: { type: 'A', name: '@', value: '76.76.21.21', ttl: 3600 } });
  assert.strictEqual(add.status, 200);
  const rec = await j(add);
  const sent = t.ns.calls.find((c) => c.op === 'dnsAddRecord').q;
  assert.deepStrictEqual([sent.domain, sent.rrtype, sent.rrhost, sent.rrvalue, sent.rrttl], ['neuf.com', 'A', '', '76.76.21.21', '3600']);
  const upd = await t.user('/api/domains/neuf.com/dns/' + rec.id, { method: 'PATCH', body: { type: 'A', name: 'www', value: '76.76.21.22' } });
  assert.strictEqual(upd.status, 200);
  const u = t.ns.calls.find((c) => c.op === 'dnsUpdateRecord').q;
  assert.deepStrictEqual([u.rrid, u.rrhost, u.rrvalue], ['r1', 'www', '76.76.21.22']);
  assert.strictEqual(t.db.get('SELECT provider_id FROM dns_records WHERE id = ?', rec.id).provider_id, 'r2', 'le record_id NameSilo change après chaque mise à jour');
  assert.strictEqual((await t.user('/api/domains/neuf.com/dns/' + rec.id, { method: 'DELETE' })).status, 200);
  assert.ok(t.ns.calls.some((c) => c.op === 'dnsDeleteRecord' && c.q.rrid === 'r2'));
  assert.strictEqual((await j(await t.user('/api/domains/neuf.com/dns'))).length, 0);
});

test('DNS : validations (type, IPv4, CNAME à la racine, TTL, hôte, doublon) et isolation entre comptes', async () => {
  const t = await withDomain();
  const post = (b) => t.user('/api/domains/neuf.com/dns', { method: 'POST', body: b });
  for (const b of [{ type: 'SRV', name: '@', value: 'x' }, { type: 'A', name: '@', value: '999.1.1.1' }, { type: 'CNAME', name: '@', value: 'cible.com' }, { type: 'CNAME', name: 'www', value: 'pas un nom' }, { type: 'A', name: '@', value: '1.1.1.1', ttl: 5 }, { type: 'A', name: 'bad host!', value: '1.1.1.1' }, { type: 'MX', name: '@', value: 'mail.x.com', priority: -1 }])
    assert.strictEqual((await post(b)).status, 400, JSON.stringify(b));
  assert.strictEqual((await post({ type: 'A', name: '@', value: '1.1.1.1' })).status, 200);
  assert.strictEqual((await post({ type: 'A', name: '@', value: '1.1.1.1' })).status, 409);
  assert.strictEqual((await t.as('autre@example.com')('/api/domains/neuf.com/dns')).status, 404);
});

test('DNS : échec du serveur DNS -> 502 et rien d’enregistré localement', async () => {
  const t = await withDomain();
  t.ns.calls.length = 0;
  const bad = t.app.app.registrar;
  bad.dnsAdd = async () => { throw Object.assign(new Error('x'), { code: 280 }); };
  assert.strictEqual((await t.user('/api/domains/neuf.com/dns', { method: 'POST', body: { type: 'A', name: '@', value: '1.1.1.1' } })).status, 502);
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM dns_records').n, 0);
});

test('DNS e-mail : autofix ajoute les 6 enregistrements, remplace un MX incorrect géré, est idempotent ; les enregistrements gérés sont protégés', async () => {
  const t = await withMail();
  let recs = await j(await t.user('/api/domains/neuf.com/dns'));
  assert.strictEqual(recs.filter((r) => r.managed).length, 6);
  const mx = recs.find((r) => r.type === 'MX');
  await t.user('/api/domains/neuf.com/dns/' + mx.id, { method: 'PATCH', body: { type: 'MX', name: '@', value: 'mauvais.example.com', priority: 10 } });
  assert.strictEqual((await t.user('/api/domains/neuf.com/dns/' + mx.id, { method: 'DELETE' })).status, 400, 'enregistrement géré non supprimable');
  assert.strictEqual((await t.user('/api/domains/neuf.com/dns/' + mx.id, { method: 'PATCH', body: { type: 'A', name: '@', value: '1.1.1.1' } })).status, 400, 'type non modifiable');
  const fix = await j(await t.user('/api/domains/neuf.com/dns/autofix', { method: 'POST' }));
  assert.strictEqual(fix.added, 1);
  recs = await j(await t.user('/api/domains/neuf.com/dns'));
  assert.strictEqual(recs.filter((r) => r.type === 'MX').length, 1);
  assert.strictEqual(recs.find((r) => r.type === 'MX').value, 'mailserver.purelymail.com');
  assert.strictEqual((await j(await t.user('/api/domains/neuf.com/dns/autofix', { method: 'POST' }))).added, 0);
});

test('DNS : propagation réelle via les résolveurs (injectés)', async () => {
  const t = await withMail();
  t.dnsState.mx['neuf.com'] = [{ exchange: 'mailserver.purelymail.com', priority: 50 }];
  const r = await j(await t.user('/api/domains/neuf.com/dns/check'));
  assert.strictEqual(r.length, 4);
  assert.ok(r.every((x) => x.ok));
  delete t.dnsState.mx['neuf.com'];
  assert.ok((await j(await t.user('/api/domains/neuf.com/dns/check'))).every((x) => !x.ok));
});

test('domaine existant (mode records) : ajout, zone préparée, vérification DNS réelle, doublon, domaine déjà actif ailleurs', async () => {
  const t = await setup({ payments: demoPay });
  const c = await t.user('/api/domains/connect', { method: 'POST', body: { domain: 'https://www.Externe.com/', mode: 'records' } });
  const d = await j(c);
  assert.strictEqual(d.domain, 'externe.com');
  assert.strictEqual(d.records.length, 6);
  assert.strictEqual(t.db.get('SELECT status FROM domains').status, 'pending');
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM dns_records').n, 6);
  assert.ok(!t.ns.calls.some((c2) => c2.op.startsWith('dns')), 'pas d’appel NameSilo pour un domaine externe');
  let v = await j(await t.user('/api/domains/externe.com/verify', { method: 'POST' }));
  assert.strictEqual(v.connected, false);
  assert.deepStrictEqual(v.missing, ['MX', 'SPF']);
  t.dnsState.mx['externe.com'] = [{ exchange: 'mailserver.purelymail.com', priority: 50 }];
  t.dnsState.txt['externe.com'] = [['v=spf1 include:_spf.purelymail.com ~all']];
  v = await j(await t.user('/api/domains/externe.com/verify', { method: 'POST' }));
  assert.strictEqual(v.connected, true);
  assert.strictEqual(t.db.get('SELECT status FROM domains').status, 'active');
  assert.strictEqual((await t.user('/api/domains/connect', { method: 'POST', body: { domain: 'externe.com' } })).status, 409);
  assert.strictEqual((await t.as('autre@example.com')('/api/domains/connect', { method: 'POST', body: { domain: 'externe.com' } })).status, 409, 'actif chez un autre compte');
  assert.strictEqual((await t.user('/api/domains/connect', { method: 'POST', body: { domain: 'pas un domaine' } })).status, 400);
});

test('domaine existant (mode nameservers) : indisponible sans serveurs Freda ; avec serveurs, vérifie la délégation NS', async () => {
  const t = await setup();
  await t.user('/api/domains/connect', { method: 'POST', body: { domain: 'externe.com', mode: 'nameservers' } });
  assert.strictEqual((await t.user('/api/domains/externe.com/verify', { method: 'POST' })).status, 409);
  const t2 = await setup({ env: { NAMESERVERS: 'ns1.fredaworkspace.com,ns2.fredaworkspace.com' } });
  await t2.user('/api/domains/connect', { method: 'POST', body: { domain: 'externe.com', mode: 'nameservers' } });
  t2.dnsState.ns['externe.com'] = ['ns1.fredaworkspace.com.'];
  assert.deepStrictEqual((await j(await t2.user('/api/domains/externe.com/verify', { method: 'POST' }))).missing, ['NS ns2.fredaworkspace.com']);
  t2.dnsState.ns['externe.com'] = ['ns1.fredaworkspace.com', 'NS2.fredaworkspace.com'];
  assert.strictEqual((await j(await t2.user('/api/domains/externe.com/verify', { method: 'POST' }))).connected, true);
});

test('deux comptes peuvent réclamer le même domaine en attente ; le premier à le prouver (DNS) l’obtient', async () => {
  const t = await setup();
  await t.user('/api/domains/connect', { method: 'POST', body: { domain: 'partage.com', mode: 'records' } });
  await t.as('autre@example.com')('/api/domains/connect', { method: 'POST', body: { domain: 'partage.com', mode: 'records' } });
  t.dnsState.mx['partage.com'] = [{ exchange: 'mailserver.purelymail.com', priority: 50 }];
  t.dnsState.txt['partage.com'] = [['v=spf1 include:_spf.purelymail.com ~all']];
  assert.strictEqual((await j(await t.as('autre@example.com')('/api/domains/partage.com/verify', { method: 'POST' }))).connected, true);
  assert.strictEqual((await t.user('/api/domains/partage.com/verify', { method: 'POST' })).status, 409);
  assert.strictEqual(t.db.get("SELECT COUNT(*) AS n FROM domains WHERE name = 'partage.com' AND status = 'active'").n, 1, 'un seul propriétaire actif');
});

/* ---------- Freda Mail ---------- */
test('boîtes : création (Purelymail), quota de l’offre, doublon, alias, suppression ; mot de passe initial renvoyé une seule fois', async () => {
  const t = await withMail();
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM mailboxes').n, 1);
  const second = await t.user('/api/mailboxes', { method: 'POST', body: { local: 'ventes', domain: 'neuf.com' } });
  assert.strictEqual(second.status, 403, 'Starter = 1 boîte');
  assert.match((await j(second)).message, /Starter/);
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'contact', domain: 'neuf.com' } })).status, 403);
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly' } });
  const ok = await t.user('/api/mailboxes', { method: 'POST', body: { local: 'ventes', domain: 'neuf.com', name: 'Service ventes' } });
  assert.strictEqual(ok.status, 200);
  const created = await j(ok);
  assert.ok(created.initialPassword && created.initialPassword.length >= 12);
  assert.ok(!JSON.stringify(t.db.all('SELECT * FROM mailboxes')).includes(created.initialPassword), 'mot de passe jamais stocké');
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'ventes', domain: 'neuf.com' } })).status, 409);
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'Bad Name!', domain: 'neuf.com' } })).status, 400);
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'x', domain: 'pas-a-moi.com' } })).status, 404);
  const al = await t.user('/api/aliases', { method: 'POST', body: { from: 'info@neuf.com', to: 'contact@neuf.com' } });
  assert.strictEqual(al.status, 200);
  assert.strictEqual(t.pm.calls.find((c) => c.path.endsWith('/createRoutingRule')).body.prefix, 'info');
  assert.strictEqual((await t.user('/api/aliases', { method: 'POST', body: { from: 'info@neuf.com', to: 'contact@neuf.com' } })).status, 409);
  assert.strictEqual((await t.user('/api/aliases', { method: 'POST', body: { from: 'x@neuf.com', to: 'inconnu@neuf.com' } })).status, 400);
  const w = await j(await t.user('/api/workspace'));
  assert.strictEqual(w.aliases.length, 1);
  assert.strictEqual((await t.user('/api/mailboxes/' + created.mailbox.id, { method: 'DELETE' })).status, 200);
  assert.ok(t.pm.calls.some((c) => c.path.endsWith('/deleteUser')));
});

test('boîtes : sans offre active -> 402 ; échec Purelymail -> 502 sans boîte fantôme ; sans clé Purelymail -> boîte « en attente »', async () => {
  const t = await withDomain();
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'a', domain: 'neuf.com' } })).status, 402);
  const noKey = await setup({ payments: demoPay, env: { PURELYMAIL_API_KEY: '' } });
  await noKey.user('/api/checkout', { method: 'POST', body: { kind: 'domain', domains: ['neuf.com'], years: 1 } });
  await noKey.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'starter', cycle: 'monthly', domain: 'neuf.com', mailbox: { local: 'contact' } } });
  const b = noKey.db.get('SELECT provider_status FROM mailboxes');
  assert.strictEqual(b.provider_status, 'pending_provider');
});

test('boîtes : panne Purelymail -> 502 et aucune boîte fantôme', async () => {
  const t = await withMail();
  await t.user('/api/checkout', { method: 'POST', body: { kind: 'subscription', plan: 'business', cycle: 'monthly' } });
  t.pmState.fail = true;
  assert.strictEqual((await t.user('/api/mailboxes', { method: 'POST', body: { local: 'ventes', domain: 'neuf.com' } })).status, 502);
  assert.strictEqual(t.db.get('SELECT COUNT(*) AS n FROM mailboxes').n, 1);
});

/* ---------- Réglages de domaine ---------- */
test('domaine : verrouillage, rappels, code de transfert (EPP) -> demande + alerte, domaine externe refusé', async () => {
  const alerts = [];
  const t = await withDomain({ deps: { alert: async (...a) => alerts.push(a) } });
  t.ns.calls.length = 0;
  const unlocked = await j(await t.user('/api/domains/neuf.com', { method: 'PATCH', body: { locked: false, autoRenew: false } }));
  assert.deepStrictEqual([unlocked.locked, unlocked.autoRenew], [false, false]);
  assert.ok(t.ns.calls.some((c) => c.op === 'domainUnlock'));
  const epp = await t.user('/api/domains/neuf.com/auth-code', { method: 'POST' });
  assert.strictEqual(epp.status, 200);
  assert.ok(t.ns.calls.some((c) => c.op === 'retrieveAuthCode' && c.q.domain === 'neuf.com'));
  assert.ok(alerts.some(([, m]) => /EPP/.test(m)));
  await t.user('/api/domains/neuf.com', { method: 'PATCH', body: { locked: true } });
  assert.strictEqual((await t.user('/api/domains/neuf.com/auth-code', { method: 'POST' })).status, 409, 'verrouillé : transfert impossible');
  await t.user('/api/domains/connect', { method: 'POST', body: { domain: 'externe.com' } });
  assert.strictEqual((await t.user('/api/domains/externe.com', { method: 'PATCH', body: { locked: true } })).status, 400);
});
