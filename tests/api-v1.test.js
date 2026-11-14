const test = require('node:test');
const assert = require('node:assert');
const { withApi, raw, j, waitFor, PW } = require('./api-helpers');
const { closeAll } = require('./helpers');
const { issueMailboxToken } = require('../src/auth');
const { idsOf, threadIdOf, encodeId, decodeId } = require('../src/mail-gateway');
const { parseRecipients } = require('../src/api-v1');
const closers = [];
test.after(async () => { closers.forEach((c) => c()); await closeAll(); });
const mk = async (over) => { const t = await withApi(over); closers.push(t.close); return t; };
const sentText = (t) => t.inbox().messages.map((m) => String(m.raw || ''));   // l'SMTP de test dépose chaque envoi dans INBOX

test('clés API : création (clé montrée une seule fois), liste sans clé, portée et nom validés, empreinte seule en base', async () => {
  const t = await mk();
  assert.strictEqual((await t.api('/api/mail/api-keys')).status, 401, 'sans session');
  assert.strictEqual((await t.api('/api/mail/api-keys', { headers: { 'X-Demo-User': 'paul@example.com' } })).status, 401, 'session de compte refusée');
  assert.strictEqual((await t.mb('/api/mail/api-keys', { method: 'POST', body: { name: '', scope: 'read' } })).status, 400);
  assert.strictEqual((await t.mb('/api/mail/api-keys', { method: 'POST', body: { name: 'x', scope: 'admin' } })).status, 400);
  assert.strictEqual((await t.mb('/api/mail/api-keys', { method: 'POST', body: { name: 'x\ny', scope: 'read' } })).status, 400);
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createAppPassword')).length, 0, 'rien créé chez Purelymail pour une demande invalide');
  const k = await t.newKey('read', 'Zapier');
  assert.match(k.key, /^fmk_[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(k.scope, 'read'); assert.strictEqual(k.prefix, k.key.slice(0, 12));
  const l = await j(await t.mb('/api/mail/api-keys'));
  assert.strictEqual(l.keys.length, 1);
  assert.ok(!JSON.stringify(l).includes(k.key), 'la clé complète n’est jamais renvoyée par la liste');
  const rows = JSON.stringify(await t.db.all('SELECT * FROM api_keys'));
  assert.ok(!rows.includes(k.key), 'la clé en clair n’est pas en base');
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createAppPassword')).length, 1);
  await t.newKey('read', 'Deuxième');
  assert.strictEqual(t.pm.calls.filter((c) => c.path.endsWith('/createAppPassword')).length, 1, 'un seul mot de passe d’application « Freda API » par boîte');
  assert.ok(!JSON.stringify(await t.db.all('SELECT * FROM api_credentials')).includes('app-pw-1'), 'identifiant chiffré au repos');
});

test('limite de 10 clés ; suppression : 404 si inconnue, mot de passe d’application révoqué quand il ne reste ni clé ni webhook', async () => {
  const t = await mk();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push((await t.newKey('read', 'k' + i)).id);
  assert.strictEqual((await t.mb('/api/mail/api-keys', { method: 'POST', body: { name: 'onze', scope: 'read' } })).status, 409);
  assert.strictEqual((await t.mb('/api/mail/api-keys/key_inconnue', { method: 'DELETE' })).status, 404);
  for (const id of ids.slice(0, 9)) assert.strictEqual((await t.mb('/api/mail/api-keys/' + id, { method: 'DELETE' })).status, 200);
  assert.ok(t.pmState.appPasswords['contact@neuf.com'].length === 1, 'encore une clé : identifiant conservé');
  assert.strictEqual((await t.mb('/api/mail/api-keys/' + ids[9], { method: 'DELETE' })).status, 200);
  assert.strictEqual(t.pmState.appPasswords['contact@neuf.com'].length, 0, 'identifiant révoqué chez Purelymail');
  assert.strictEqual((await t.db.get('SELECT COUNT(*) AS n FROM api_credentials')).n, 0);
});

test('authentification : clé absente / mal formée / inconnue -> 401 ; une clé ne gère ni les clés ni le webhook ; supprimée -> refusée', async () => {
  const t = await mk();
  const k = await t.newKey();
  assert.strictEqual((await t.api('/api/v1/me')).status, 401);
  assert.strictEqual((await t.v1('/me', 'pas-une-cle')).status, 401);
  assert.strictEqual((await t.v1('/me', 'fmk_' + 'A'.repeat(43))).status, 401);
  assert.strictEqual((await t.v1('/me', t.token)).status, 401, 'le jeton de session n’est pas une clé API');
  const me = await j(await t.v1('/me', k.key));
  assert.strictEqual(me.mailbox, 'contact@neuf.com'); assert.strictEqual(me.key.scope, 'read_send'); assert.strictEqual(me.limits.sends_per_minute, 10);
  for (const [p, m] of [['/api/mail/api-keys', 'GET'], ['/api/mail/api-keys', 'POST'], ['/api/mail/webhook', 'GET'], ['/api/mail/webhook', 'PUT']]) assert.strictEqual((await t.api(p, { method: m, headers: { Authorization: 'Bearer ' + k.key }, body: m === 'GET' ? undefined : { name: 'x', url: 'https://x.test/h' } })).status, 401, m + ' ' + p);
  await t.mb('/api/mail/api-keys/' + k.id, { method: 'DELETE' });
  assert.strictEqual((await t.v1('/me', k.key)).status, 401, 'clé supprimée');
});

test('changement du mot de passe de la boîte, suspension : les clés existantes sont refusées', async () => {
  const t = await mk();
  const k = await t.newKey();
  assert.strictEqual((await t.v1('/me', k.key)).status, 200);
  const box = await t.boxId();
  assert.strictEqual((await t.user(`/api/mailboxes/${box}/password`, { method: 'POST', body: { password: 'Autre-Mot-De-Passe-2027' } })).status, 200);
  assert.strictEqual((await t.v1('/me', k.key)).status, 401, 'clé créée avant le changement de mot de passe');
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual((await t.mb('/api/mail/api-keys')).status, 401, 'la session de boîte ouverte avant est aussi déconnectée');
  t.token = issueMailboxToken(t.cfg, await t.db.get("SELECT * FROM mailboxes WHERE local_part = 'contact'"));
  const k2 = await t.newKey();
  assert.strictEqual((await t.v1('/me', k2.key)).status, 200, 'une clé créée après est valable');
  await t.db.run("UPDATE mailboxes SET provider_status = 'suspended'");
  assert.strictEqual((await t.v1('/me', k2.key)).status, 401, 'boîte suspendue');
});

test('lecture : liste (non lus, limite, curseur), contenu complet, fil de discussion, lecture seule', async () => {
  const t = await mk();
  const k = await t.newKey('read');
  const all = await j(await t.v1('/messages', k.key));
  assert.strictEqual(all.messages.length, 2);
  assert.deepStrictEqual(all.messages.map((m) => m.subject), ['Facture', 'Bonjour'], 'plus récents d’abord');
  const unread = await j(await t.v1('/messages?unread=true', k.key));
  assert.deepStrictEqual(unread.messages.map((m) => m.subject), ['Bonjour']);
  assert.strictEqual(unread.messages[0].unread, true);
  const page1 = await j(await t.v1('/messages?limit=1', k.key));
  assert.strictEqual(page1.messages.length, 1); assert.ok(page1.next_cursor);
  const page2 = await j(await t.v1('/messages?limit=1&cursor=' + page1.next_cursor, k.key));
  assert.strictEqual(page2.messages[0].subject, 'Bonjour'); assert.strictEqual(page2.next_cursor, null);
  const full = await j(await t.v1('/messages/' + unread.messages[0].id, k.key));
  assert.strictEqual(full.text.trim(), 'Salut le monde'); assert.strictEqual(full.from.address, 'marie@ex.com'); assert.strictEqual(full.thread_id, '<m1@ex.com>');
  assert.strictEqual((await j(await t.v1('/messages?unread=true', k.key))).messages.length, 1, 'lire ne marque pas comme lu');
  for (const q of ['limit=0', 'limit=51', 'limit=abc', 'unread=maybe', 'folder=trash', 'cursor=x']) assert.strictEqual((await t.v1('/messages?' + q, k.key)).status, 400, q);
  assert.strictEqual((await t.v1('/messages/pas-un-id', k.key)).status, 400);
  assert.strictEqual((await t.v1('/messages/' + encodeId('inbox', '999', 1), k.key)).status, 404, 'uidvalidity différent');
  assert.strictEqual((await t.v1('/messages/' + encodeId('inbox', decodeId(unread.messages[0].id).validity, 999), k.key)).status, 404);
  assert.strictEqual((await t.v1('/messages/send', k.key, { method: 'POST', body: { to: 'a@b.co', subject: 's', text: 't' } })).status, 403, 'clé en lecture seule');
  assert.strictEqual((await t.v1('/messages/' + unread.messages[0].id, k.key, { method: 'PATCH', body: { unread: false } })).status, 403);
});

test('marquer lu / non lu (clé lecture + envoi)', async () => {
  const t = await mk();
  const k = await t.newKey('read_send');
  const [m] = (await j(await t.v1('/messages?unread=true', k.key))).messages;
  assert.strictEqual((await t.v1('/messages/' + m.id, k.key, { method: 'PATCH', body: { unread: 'oui' } })).status, 400);
  assert.deepStrictEqual(await j(await t.v1('/messages/' + m.id, k.key, { method: 'PATCH', body: { unread: false } })), { id: m.id, unread: false });
  assert.strictEqual((await j(await t.v1('/messages?unread=true', k.key))).messages.length, 0);
});

test('envoi : réponse rattachée au fil (In-Reply-To, References, Re:), destinataire déduit, expéditeur = la boîte, copie dans Envoyés, Idempotency-Key', async () => {
  const t = await mk();
  const k = await t.newKey('read_send');
  const [m] = (await j(await t.v1('/messages?unread=true', k.key))).messages;
  const r = await t.v1('/messages/send', k.key, { method: 'POST', headers: { 'Idempotency-Key': 'rejeu-0001-abcd' }, body: { reply_to_message_id: m.id, text: 'Merci pour votre message.', from: 'pirate@evil.test' } });
  assert.strictEqual(r.status, 200);
  const out = await j(r);
  assert.strictEqual(out.status, 'sent'); assert.strictEqual(out.thread_id, '<m1@ex.com>'); assert.match(out.message_id, /^<[0-9a-f]{32}@neuf\.com>$/); assert.strictEqual(out.saved_to_sent, true);
  const mail = (await waitFor(() => sentText(t).find((x) => x.includes(out.message_id))));
  assert.match(mail, /^From: .*contact@neuf\.com/mi, 'expéditeur = la boîte');
  assert.ok(!/pirate@evil/.test(mail), 'le champ « from » de la requête est ignoré');
  assert.match(mail, /^To: .*marie@ex\.com/mi); assert.match(mail, /^Subject: Re: Bonjour/mi);
  assert.match(mail, /^In-Reply-To: <m1@ex\.com>/mi); assert.match(mail, /^References: <m1@ex\.com>/mi);
  assert.ok(t.imapServer.getMailbox('Sent').messages.length === 1, 'copie dans Envoyés');
  assert.ok(t.inbox().messages[0].flags.includes('\\Answered'), 'message d’origine marqué « répondu »');   // (l'SMTP de test dépose aussi l'envoi dans INBOX : on ne compte pas les non lus)
  const before = sentText(t).length;
  const again = await j(await t.v1('/messages/send', k.key, { method: 'POST', headers: { 'Idempotency-Key': 'rejeu-0001-abcd' }, body: { reply_to_message_id: m.id, text: 'Merci pour votre message.' } }));
  assert.strictEqual(again.idempotent_replay, true); assert.strictEqual(again.message_id, out.message_id);
  await new Promise((r2) => setTimeout(r2, 150));
  assert.strictEqual(sentText(t).length, before, 'pas de second envoi');
  // réponse par thread_id
  const byThread = await j(await t.v1('/messages/send', k.key, { method: 'POST', body: { thread_id: 'm1@ex.com', text: 'Relance' } }));
  const mail2 = await waitFor(() => sentText(t).find((x) => x.includes(byThread.message_id)));
  assert.match(mail2, /^In-Reply-To: <[^>]+@[^>]+>/mi);   // dernier message du fil (ici aussi notre première réponse : l'SMTP de test la dépose dans INBOX) assert.match(mail2, /^References: .*<m1@ex\.com>/mi); assert.match(mail2, /^Subject: Re: /mi);
  // nouveau message
  const fresh = await j(await t.v1('/messages/send', k.key, { method: 'POST', body: { to: [{ name: 'Paul', address: 'paul@client.test' }], cc: 'cc@client.test', bcc: 'cache@client.test', subject: 'Votre devis', text: 'Bonjour', html: '<p>Bonjour</p>' } }));
  assert.deepStrictEqual(fresh.accepted.sort(), ['cache@client.test', 'cc@client.test', 'paul@client.test']);
  const mail3 = await waitFor(() => sentText(t).find((x) => x.includes(fresh.message_id)));
  assert.match(mail3, /^To: .*paul@client\.test/mi); assert.ok(!/cache@client\.test/.test(mail3), 'Bcc jamais dans les en-têtes');
});

test('envoi : validations (destinataires, objet, corps, injection d’en-têtes, taille) -> 400 sans rien envoyer', async () => {
  const t = await mk();
  const k = await t.newKey('read_send');
  const before = sentText(t).length;
  const post = (body, h) => t.v1('/messages/send', k.key, { method: 'POST', body, headers: h });
  const ok = { to: 'a@b.co', subject: 's', text: 't' };
  assert.strictEqual((await post({ subject: 's', text: 't' })).status, 400, 'pas de destinataire');
  assert.strictEqual((await post({ ...ok, to: 'pas-une-adresse' })).status, 400);
  assert.strictEqual((await post({ ...ok, to: 'a@b.co\r\nBcc: x@y.zz' })).status, 400, 'injection dans une adresse');
  assert.strictEqual((await post({ ...ok, to: { address: 'a@b.co', name: 'X\r\nBcc: v@w.xy' } })).status, 400, 'injection dans un nom');
  assert.strictEqual((await post({ ...ok, subject: 'a\r\nBcc: v@w.xy' })).status, 400, 'injection dans l’objet');
  assert.strictEqual((await post({ to: 'a@b.co', text: 't' })).status, 400, 'objet requis pour un nouveau message');
  assert.strictEqual((await post({ to: 'a@b.co', subject: 's' })).status, 400, 'message vide');
  assert.strictEqual((await post({ ...ok, to: Array.from({ length: 51 }, (_, i) => `u${i}@ex.co`) })).status, 400, '51 destinataires');
  assert.strictEqual((await post({ ...ok, text: 'x'.repeat(500_001) })).status, 413);
  assert.strictEqual((await post({ ...ok, reply_to_message_id: encodeId('inbox', '1', 9999) })).status, 404);
  assert.strictEqual((await post({ ...ok, thread_id: '<a b>' })).status, 400);
  assert.strictEqual((await post(ok, { 'Idempotency-Key': 'court' })).status, 400);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sentText(t).length, before);
  assert.deepStrictEqual(parseRecipients(['A@B.CO', { name: 'N', address: 'c@d.ef' }], 'to'), ['a@b.co', { name: 'N', address: 'c@d.ef' }]);
});

test('limite de 60 requêtes/minute/clé : 429 + Retry-After + en-têtes X-RateLimit ; la limite est par clé', async () => {
  const t = await mk();
  const k = await t.newKey('read');
  let r;
  for (let i = 0; i < 60; i++) { r = await t.v1('/me', k.key); assert.strictEqual(r.status, 200, 'requête ' + i); }
  assert.strictEqual(r.headers.get('x-ratelimit-limit'), '60'); assert.strictEqual(r.headers.get('x-ratelimit-remaining'), '0');
  r = await t.v1('/me', k.key);
  assert.strictEqual(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1); assert.strictEqual((await j(r)).code, 'rate_limited');
  const k2 = await t.newKey('read', 'autre');
  assert.strictEqual((await t.v1('/me', k2.key)).status, 200);
});

test('envois : 10 par minute PAR BOÎTE (créer d’autres clés ne contourne pas la limite)', async () => {
  const t = await mk();
  const keys = [await t.newKey('read_send', 'a'), await t.newKey('read_send', 'b')];
  const send = (key) => t.v1('/messages/send', key.key, { method: 'POST', body: { to: 'a@b.co', subject: 's', text: 't' } });
  for (let i = 0; i < 10; i++) assert.strictEqual((await send(keys[i % 2])).status, 200, 'envoi ' + i);
  const r = await send(keys[0]);
  assert.strictEqual(r.status, 429); assert.ok(r.headers.get('retry-after'));
});

test('plafond quotidien d’envois par boîte (API_DAILY_SENDS) ; un envoi refusé par le serveur n’est pas compté', async () => {
  const t = await mk({ env: { API_DAILY_SENDS: '2' } });
  const k = await t.newKey('read_send');
  const send = () => t.v1('/messages/send', k.key, { method: 'POST', body: { to: 'a@b.co', subject: 's', text: 't' } });
  assert.strictEqual((await send()).status, 200); assert.strictEqual((await send()).status, 200);
  const r = await send();
  assert.strictEqual(r.status, 429); assert.strictEqual((await j(r)).code, 'daily_limit');
  assert.strictEqual((await t.db.get('SELECT sends FROM api_usage')).sends, 2, 'le refus est annulé du compteur');
});

test('clés invalides : 20 échecs / 10 min / IP puis 429 (même pour une clé valable depuis cette IP)', async () => {
  const t = await mk();
  const k = await t.newKey('read');
  for (let i = 0; i < 20; i++) assert.strictEqual((await t.v1('/me', 'fmk_' + 'B'.repeat(43))).status, 401);
  assert.strictEqual((await t.v1('/me', 'fmk_' + 'B'.repeat(43))).status, 429);
  assert.strictEqual((await t.v1('/me', k.key)).status, 429);
});

test('abonnement inactif : 402', async () => {
  const t = await mk();
  const k = await t.newKey('read');
  await t.db.run("UPDATE subscriptions SET status = 'cancelled'");
  assert.strictEqual((await t.v1('/me', k.key)).status, 402);
});

test('documentation : openapi.json (3 endpoints + messages/{id}) et page HTML sans script, avec CSP stricte', async () => {
  const t = await mk();
  const spec = await j(await t.api('/api/v1/openapi.json'));
  assert.strictEqual(spec.openapi, '3.0.3');
  for (const p of ['/api/v1/messages', '/api/v1/messages/{id}', '/api/v1/messages/send']) assert.ok(spec.paths[p], p);
  assert.ok(spec.paths['/api/v1/messages'].get.parameters.some((x) => x.name === 'unread'));
  assert.strictEqual(spec.servers[0].url, 'https://api.test');
  const r = await t.api('/api/v1/docs');
  assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await r.text();
  assert.ok(!/<script/i.test(html)); assert.ok(html.includes('/api/v1/messages/send')); assert.ok(html.includes('X-Freda-Signature'));
});

test('helpers : identifiants opaques, fils de discussion, en-têtes dépliés', () => {
  assert.deepStrictEqual(decodeId(encodeId('inbox', '5', 7)), { folder: 'inbox', validity: '5', uid: 7 });
  assert.throws(() => decodeId('aaaa'), /invalide/);
  assert.throws(() => decodeId(Buffer.from('drafts:1:2').toString('base64url')), /invalide/);
  assert.deepStrictEqual(idsOf('Subject: x\r\nReferences: <a@x> <b@x>\r\n <c@x>\r\nTo: y\r\n', 'References'), ['<a@x>', '<b@x>', '<c@x>']);
  assert.strictEqual(threadIdOf('<m@x>', '<p@x>', ['<r@x>']), '<r@x>'); assert.strictEqual(threadIdOf('<m@x>', '<p@x>', []), '<p@x>'); assert.strictEqual(threadIdOf('<m@x>', null, []), '<m@x>');
});
