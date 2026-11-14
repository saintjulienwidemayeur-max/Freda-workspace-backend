/**
 * Webhook « nouveau message » d'une boîte : quand un message arrive, Freda envoie son contenu (JSON) à l'URL de l'utilisateur, en quasi temps réel (IMAP IDLE).
 *
 * Sécurité :
 *  - URL en https uniquement ; adresses privées / locales / métadonnées cloud refusées À LA CONNEXION (la résolution DNS est contrôlée au moment de se connecter,
 *    pas seulement à l'enregistrement : pas de contournement par « DNS rebinding ») ; aucune redirection suivie ; délai de 10 s ;
 *  - signature HMAC-SHA256 : X-Freda-Signature: sha256=HMAC(secret, "<X-Freda-Timestamp>.<corps>") ; le secret « whsec_… » est montré une seule fois (rotation possible),
 *    conservé chiffré ; l'horodatage permet de refuser les rejeux ;
 *  - la configuration (URL) ne se change qu'avec la session du webmail, jamais avec une clé API ;
 *  - 3 tentatives (0 s, 5 s, 30 s) ; après 10 échecs consécutifs le webhook est désactivé (le client le voit et le réactive) ;
 *  - un webhook créé avant le dernier changement de mot de passe de la boîte est ignoré (comme les sessions).
 * Pas de rattrapage historique : seuls les messages arrivés après l'activation sont envoyés ; une seule instance du serveur (état en mémoire).
 */
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const http = require('http');
const net = require('net');
const { HttpError } = require('./errors');
const { watchMailbox } = require('./push');

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref && t.unref(); });
const MAX_FAILURES = 10;
const RETRY_DELAYS = [0, 5000, 30000];

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]]) blocked.addSubnet(a, p, 'ipv6');

/** Vrai si l'adresse IP est privée / locale / réservée (y compris IPv4 écrite en IPv6 « ::ffff:10.0.0.1 »). */
function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

/** Contrôle de l'URL à l'enregistrement (la résolution DNS est contrôlée en plus à chaque connexion). */
function validateUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw new HttpError(400, 'URL invalide.', 'invalid_url'); }
  if (String(raw).length > 500) throw new HttpError(400, 'URL trop longue (500 caractères maximum).', 'invalid_url');
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new HttpError(400, 'L’URL doit commencer par https://.', 'invalid_url');
  if (u.username || u.password) throw new HttpError(400, 'L’URL ne doit pas contenir d’identifiants (utilisez le secret de signature).', 'invalid_url');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate) {
    if (net.isIP(host) ? isBlockedIp(host) : (host === 'localhost' || !host.includes('.') || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host))) throw new HttpError(400, 'Cette adresse n’est pas autorisée : utilisez une URL publique.', 'invalid_url');
  }
  return u;
}

/** Envoi HTTPS d'un événement. Résout { status } ; rejette sur erreur réseau / adresse interdite. */
function postJson(url, body, headers, { allowPrivate = false, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const lookup = (hostname, options, cb) => {
      const done = typeof options === 'function' ? options : cb;
      const opts = typeof options === 'function' ? {} : options;
      dns.lookup(hostname, { all: true, family: opts.family || 0, verbatim: true }, (err, list) => {
        if (err) return done(err);
        if (!allowPrivate && list.some((x) => isBlockedIp(x.address))) return done(Object.assign(new Error('blocked_address'), { code: 'EBLOCKED' }));
        if (opts.all) return done(null, list);
        return done(null, list[0].address, list[0].family);
      });
    };
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, lookup, timeout: timeoutMs }, (res) => {
      let n = 0; res.on('data', (c) => { n += c.length; if (n > 65536) res.destroy(); }); res.on('end', () => resolve({ status: res.statusCode })); res.on('error', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

function createWebhooks({ cfg, db, vault, keys, gateway, log, allowPrivate = false, retryDelays = RETRY_DELAYS }) {
  const watchers = new Map();   // mailboxId -> { w, url }
  const queues = new Map();
  const view = (r) => (r ? { configured: true, url: r.url, active: !!r.active, createdAt: r.created_at, lastDeliveryAt: r.last_delivery_at || null, lastStatus: r.last_status || null, failures: r.failures, disabledReason: r.disabled_reason || null } : { configured: false });
  const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('base64url');
  const sign = (secret, ts, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  async function get(b) { return view(await db.get('SELECT * FROM api_webhooks WHERE mailbox_id = ?', b.id)); }

  async function set(b, { url } = {}) {
    const u = validateUrl(url, { allowPrivate });
    if (!(await db.get('SELECT 1 FROM api_webhooks WHERE mailbox_id = ?', b.id))) {
      if (!keys.providerReady()) throw new HttpError(503, 'La messagerie est en cours d’activation. Réessayez dans quelques minutes.', 'mailbox_not_ready');
      try { await keys.ensureCredential(b); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'Le serveur de messagerie n’a pas accepté la demande. Réessayez.', 'mail_provider_error'); }
      const secret = newSecret(), now = Date.now();
      await db.run('INSERT INTO api_webhooks (mailbox_id, url, secret_enc, active, created_at, created_ms) VALUES (?,?,?,?,?,?)', b.id, u.toString(), vault.encrypt(secret), 1, new Date(now).toISOString(), now);
      log('info', 'webhook_created', { mailbox: b.address });
      await reconcile();
      return { ...(await get(b)), secret };   // montré une seule fois
    }
    await db.run("UPDATE api_webhooks SET url = ?, active = 1, failures = 0, disabled_reason = '' WHERE mailbox_id = ?", u.toString(), b.id);
    await reconcile();
    return await get(b);
  }

  async function rotateSecret(b) {
    if (!(await db.get('SELECT 1 FROM api_webhooks WHERE mailbox_id = ?', b.id))) throw new HttpError(404, 'Aucun webhook configuré.', 'not_found');
    const secret = newSecret();
    await db.run('UPDATE api_webhooks SET secret_enc = ? WHERE mailbox_id = ?', vault.encrypt(secret), b.id);
    return { ...(await get(b)), secret };
  }

  async function remove(b) {
    await db.run('DELETE FROM api_webhooks WHERE mailbox_id = ?', b.id);
    await reconcile();
    await keys.releaseCredential(b);
    return { ok: true };
  }

  /** Une livraison (avec tentatives). Retourne { ok, status, attempts }. */
  async function deliver(row, event, data) {
    const secret = vault.decrypt(row.secret_enc);
    const id = 'dlv_' + crypto.randomBytes(8).toString('hex');
    let body = JSON.stringify({ event, delivery_id: id, created_at: new Date().toISOString(), mailbox: data.mailbox, message: data.message });
    if (body.length > 900_000 && data.message && data.message.html) body = JSON.stringify({ event, delivery_id: id, created_at: new Date().toISOString(), mailbox: data.mailbox, message: { ...data.message, html: null, truncated: true } });
    let last = { ok: false, status: 'network_error' }, attempts = 0;
    for (const d of retryDelays) {
      if (d) await sleep(d);
      attempts++;
      const ts = String(Math.floor(Date.now() / 1000));
      try {
        const r = await postJson(row.url, body, { 'Content-Type': 'application/json', 'User-Agent': 'Freda-Webhooks/1', 'X-Freda-Event': event, 'X-Freda-Delivery': id, 'X-Freda-Timestamp': ts, 'X-Freda-Signature': sign(secret, ts, body) }, { allowPrivate });
        last = { ok: r.status >= 200 && r.status < 300, status: String(r.status) };
        if (last.ok || (r.status >= 400 && r.status < 500 && ![408, 429].includes(r.status))) break;   // erreur définitive : inutile de réessayer
      } catch (e) { last = { ok: false, status: e.code === 'EBLOCKED' ? 'blocked_address' : (e.code || 'network_error') }; if (e.code === 'EBLOCKED') break; }
    }
    return { ...last, attempts };
  }

  async function record(mailboxId, res) {
    if (res.ok) await db.run("UPDATE api_webhooks SET failures = 0, last_status = ?, last_delivery_at = ? WHERE mailbox_id = ?", res.status, new Date().toISOString(), mailboxId);
    else {
      await db.run('UPDATE api_webhooks SET failures = failures + 1, last_status = ?, last_delivery_at = ? WHERE mailbox_id = ?', res.status, new Date().toISOString(), mailboxId);
      const r = await db.get('SELECT failures FROM api_webhooks WHERE mailbox_id = ?', mailboxId);
      if (r && r.failures >= MAX_FAILURES) { await db.run("UPDATE api_webhooks SET active = 0, disabled_reason = 'too_many_failures' WHERE mailbox_id = ?", mailboxId); log('warn', 'webhook_disabled', { mailbox: mailboxId }); await reconcile(); }
    }
  }

  async function test(b) {
    const row = await db.get('SELECT * FROM api_webhooks WHERE mailbox_id = ?', b.id);
    if (!row) throw new HttpError(404, 'Aucun webhook configuré.', 'not_found');
    const res = await deliver(row, 'webhook.test', { mailbox: b.address, message: { id: 'test', subject: 'Test Freda Mail', text: 'Ceci est un événement de test.', from: { name: 'Freda Mail', address: b.address }, to: [{ name: '', address: b.address }], date: new Date().toISOString(), unread: true } });
    await record(b.id, res);
    return { delivered: res.ok, status: res.status, attempts: res.attempts };
  }

  /** Livre les messages arrivés (uid fromUid..toUid) ; une file par boîte : l'ordre d'arrivée est respecté. */
  function onNew(row, info) {
    const prev = queues.get(row.mailbox_id) || Promise.resolve();
    const next = prev.then(async () => {
      const cur = await db.get('SELECT * FROM api_webhooks WHERE mailbox_id = ?', row.mailbox_id);
      if (!cur || !cur.active) return;
      const b = await db.get('SELECT * FROM mailboxes WHERE id = ?', row.mailbox_id);
      const creds = b && await keys.credentialFor(b);
      if (!creds) return;
      let msgs;
      try { msgs = await gateway.fetchRange(creds, info.fromUid, info.toUid, 20); } catch (e) { log('warn', 'webhook_fetch_failed', { mailbox: b.address }); return; }
      for (const message of msgs) { const res = await deliver(cur, 'message.received', { mailbox: b.address, message }); await record(row.mailbox_id, res); if (!res.ok && (await db.get('SELECT active FROM api_webhooks WHERE mailbox_id = ?', row.mailbox_id) || {}).active === 0) break; }
    }).catch((e) => log('warn', 'webhook_delivery_failed', { message: e.message }));
    queues.set(row.mailbox_id, next);
    return next;
  }

  /** Aligne les observateurs IMAP sur la base : un par webhook actif d'une boîte active (créé après le dernier changement de mot de passe). */
  let rec = Promise.resolve();
  function reconcile() {
    rec = rec.then(async () => {
      const want = await db.all(`SELECT w.*, m.address FROM api_webhooks w JOIN mailboxes m ON m.id = w.mailbox_id
        WHERE w.active = 1 AND m.provider_status = 'active' AND w.created_ms > m.tokens_valid_after`);
      const ids = new Set(want.map((r) => r.mailbox_id));
      for (const [mid, x] of watchers) if (!ids.has(mid)) { x.w.stop(); watchers.delete(mid); }
      for (const row of want) {
        if (watchers.has(row.mailbox_id)) continue;
        const b = await db.get('SELECT * FROM mailboxes WHERE id = ?', row.mailbox_id);
        const creds = await keys.credentialFor(b);
        if (!creds) continue;
        const w = watchMailbox({
          imap: cfg.imap, user: creds.user, pass: creds.pass, preview: false, log,
          getLastUid: async () => { const r = await db.get('SELECT last_uid FROM api_webhooks WHERE mailbox_id = ?', row.mailbox_id); return r ? r.last_uid : null; },
          setLastUid: async (uid) => db.run('UPDATE api_webhooks SET last_uid = ? WHERE mailbox_id = ?', uid, row.mailbox_id),
          onNew: (info) => { if (info.fromUid) onNew(row, info); },
          onDenied: async () => { watchers.delete(row.mailbox_id); await db.run('DELETE FROM api_credentials WHERE mailbox_id = ?', row.mailbox_id); },   // identifiant révoqué : recréé par la prochaine configuration
        });
        watchers.set(row.mailbox_id, { w });
      }
    }).catch((e) => log('warn', 'webhook_reconcile_failed', { message: e.message }));
    return rec;
  }

  let timer = null;
  return {
    get, set, rotateSecret, remove, test, reconcile, deliver, sign,
    watchers: () => watchers,
    async start() { await reconcile(); if (!timer) { timer = setInterval(() => reconcile(), 60_000); timer.unref(); } },
    stop() { clearInterval(timer); timer = null; for (const x of watchers.values()) x.w.stop(); watchers.clear(); },
  };
}

module.exports = { createWebhooks, validateUrl, isBlockedIp, postJson };
