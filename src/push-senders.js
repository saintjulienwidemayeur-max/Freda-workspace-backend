/**
 * Envoi des notifications : APNs (iPhone, HTTP/2 + jeton JWT ES256) et FCM HTTP v1 (Android, OAuth2 par compte de service). Sans dépendance.
 * Chaque envoi retourne { ok: true } ou { invalid: true } (jeton d'appareil mort : à supprimer) et lève une erreur pour toute autre panne.
 *  - APNs : https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
 *           POST /3/device/<jeton>, en-têtes authorization: bearer <jwt>, apns-push-type: alert, apns-topic: <bundle id> ; 410 / BadDeviceToken = jeton mort.
 *           Le jeton JWT {alg: ES256, kid} {iss: team id, iat} est renouvelé au plus toutes les 45 minutes (Apple exige entre 20 et 60 min).
 *  - FCM  : POST /v1/projects/<projet>/messages:send avec « Authorization: Bearer <jeton OAuth> » (portée firebase.messaging) ; UNREGISTERED = jeton mort.
 */
const crypto = require('crypto');
const http2 = require('http2');

const b64u = (b) => Buffer.from(b).toString('base64url');
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function createApns(cfg) {
  const { key, keyId, teamId, bundleId, baseUrl } = cfg.push.apns;
  let session = null, jwt = null, jwtAt = 0;
  const token = (force) => {
    const now = Math.floor(Date.now() / 1000);
    if (!force && jwt && now - jwtAt < 45 * 60) return jwt;
    const h = b64u(JSON.stringify({ alg: 'ES256', kid: keyId })), p = b64u(JSON.stringify({ iss: teamId, iat: now }));
    jwt = `${h}.${p}.${b64u(crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }))}`; jwtAt = now;
    return jwt;
  };
  const conn = () => {
    if (session && !session.closed && !session.destroyed) return session;
    const s = http2.connect(baseUrl);
    s.on('error', () => { if (session === s) session = null; });
    s.on('close', () => { if (session === s) session = null; });
    s.unref();
    return (session = s);
  };
  function once(deviceToken, payload, collapseId, forceJwt) {
    return new Promise((resolve, reject) => {
      const req = conn().request({
        ':method': 'POST', ':path': `/3/device/${deviceToken}`, authorization: `bearer ${token(forceJwt)}`,
        'apns-push-type': 'alert', 'apns-topic': bundleId, 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        ...(collapseId ? { 'apns-collapse-id': clip(collapseId, 64) } : {}), 'content-type': 'application/json',
      });
      let status = 0, body = '';
      req.setEncoding('utf8'); req.setTimeout(10000, () => { req.close(); reject(new Error('apns_timeout')); });
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => { body += d; });
      req.on('end', () => { let reason = ''; try { reason = JSON.parse(body).reason || ''; } catch (e) { /* corps vide */ } resolve({ status, reason }); });
      req.on('error', reject);
      req.end(JSON.stringify(payload));
    });
  }
  return {
    close() { if (session) { session.destroy(); session = null; } },
    async send(deviceToken, { title, body, data = {}, collapseId }) {
      const payload = { aps: { alert: { title: clip(title, 120), body: clip(body, 240) }, sound: 'default', 'thread-id': data.mailbox || undefined }, ...data };
      let r = await once(deviceToken, payload, collapseId, false);
      if (r.status === 403 && /ExpiredProviderToken/.test(r.reason)) r = await once(deviceToken, payload, collapseId, true);
      if (r.status === 200) return { ok: true };
      if (r.status === 410 || (r.status === 400 && /^(BadDeviceToken|DeviceTokenNotForTopic)$/.test(r.reason))) return { invalid: true };
      throw new Error(`apns_${r.status}_${r.reason}`);
    },
  };
}

function createFcm(cfg) {
  const sa = cfg.push.fcm.serviceAccount, base = cfg.push.fcm.baseUrl.replace(/\/$/, '');
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  let access = null, exp = 0;
  async function accessToken(force) {
    if (!force && access && Date.now() < exp - 60000) return access;
    const now = Math.floor(Date.now() / 1000);
    const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const p = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: now, exp: now + 3600 }));
    const sig = b64u(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), sa.private_key));
    const res = await fetch(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${sig}` }), signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error('fcm_oauth_' + res.status);
    access = j.access_token; exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return access;
  }
  async function post(message, force) {
    const res = await fetch(`${base}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken(force)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }), signal: AbortSignal.timeout(15000) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
  return {
    async send(deviceToken, { title, body, data = {}, collapseId }) {
      const message = {
        token: deviceToken, notification: { title: clip(title, 120), body: clip(body, 240) },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: 'HIGH', ttl: '3600s', notification: { channel_id: 'courrier', sound: 'default', ...(collapseId ? { tag: clip(collapseId, 64) } : {}) } },
      };
      let r = await post(message, false);
      if (r.status === 401) r = await post(message, true);
      if (r.status === 200) return { ok: true };
      const err = r.json && r.json.error || {};
      const code = (err.details || []).map((d) => d.errorCode).find(Boolean);
      if (r.status === 404 || code === 'UNREGISTERED' || (r.status === 400 && err.status === 'INVALID_ARGUMENT' && /registration token|token/i.test(err.message || ''))) return { invalid: true };
      throw new Error(`fcm_${r.status}_${err.status || code || ''}`);
    },
  };
}

function createSenders(cfg) {
  const a = cfg.push.apns, f = cfg.push.fcm.serviceAccount;
  return { ios: a.key && a.keyId && a.teamId && a.bundleId ? createApns(cfg) : null, android: f && f.private_key ? createFcm(cfg) : null };
}

module.exports = { createApns, createFcm, createSenders };
