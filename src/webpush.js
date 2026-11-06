/**
 * Web Push (navigateur : version web / PWA de Freda Mail). Sans dépendance, comme APNs et FCM dans push-senders.js.
 *  - Chiffrement du message : RFC 8291 (aes128gcm). Le service de push du navigateur (Google, Mozilla, Apple, Microsoft) ne voit JAMAIS le texte.
 *  - Identification du serveur : VAPID, RFC 8292 (JWT ES256 + clé publique dans l'en-tête Authorization).
 *  - Le navigateur s'abonne avec la clé publique VAPID (GET /api/mail/push -> vapidPublicKey) ; l'abonnement { endpoint, keys: { p256dh, auth } } est
 *    enregistré comme jeton d'appareil « web ». 404 / 410 = abonnement mort : supprimé.
 *  - SÉCURITÉ : l'endpoint vient du navigateur, donc d'un inconnu ; il n'est appelé que s'il est en https ET chez un service de push connu
 *    (jamais un serveur interne : pas de SSRF).
 */
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

/** Services de push connus : Chrome / Edge / Android (FCM), Firefox (Mozilla), Safari (Apple), Windows (WNS). */
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|updates-autopush\.(stage\.)?mozaws\.net|[a-z0-9-]+\.push\.apple\.com|push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/i;
function endpointOk(endpoint, allowHost) {
  try {
    const u = new URL(String(endpoint));
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    return PUSH_HOSTS.test(u.hostname) || !!(allowHost && allowHost(u.hostname));
  } catch (e) { return false; }
}

/** Clés VAPID : publique (65 octets, 0x04 + X + Y) et privée (32 octets), en base64url ; la privée doit correspondre à la publique. */
function vapidKeysValid(publicKey, privateKey) {
  try {
    const pub = fromB64u(publicKey), priv = fromB64u(privateKey);
    if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return false;
    const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch (e) { return false; }
}
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Abonnement du navigateur -> forme canonique { endpoint, keys: { p256dh, auth } } (chaîne JSON), ou null s'il est invalide. */
function canonicalSubscription(input, allowHost) {
  let s = input;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { return null; } }
  if (!s || typeof s !== 'object') return null;
  const endpoint = String(s.endpoint || ''), keys = s.keys || {};
  if (endpoint.length > 1000 || !endpointOk(endpoint, allowHost)) return null;
  const p = fromB64u(keys.p256dh), a = fromB64u(keys.auth);
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return null;
  return JSON.stringify({ endpoint, keys: { p256dh: b64u(p), auth: b64u(a) } });
}

/** RFC 8291 : corps « aes128gcm » (salt, taille d'enregistrement, clé publique du serveur, texte chiffré). asKey / salt : seulement pour les tests (vecteur de l'RFC). */
function encrypt(payload, p256dh, auth, { asKey, salt } = {}) {
  const ecdh = crypto.createECDH('prime256v1');
  if (asKey) ecdh.setPrivateKey(asKey); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(p256dh);
  const s = salt || crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), p256dh, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);   // 0x02 : dernier (et seul) enregistrement
  const header = Buffer.alloc(21); s.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPub.length;
  return Buffer.concat([header, asPub, body]);
}

function createWebPush(cfg, { fetchImpl = fetch, allowHost } = {}) {
  const { publicKey, privateKey, subject } = cfg.push.web;
  const pub = fromB64u(publicKey);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey }, format: 'jwk' });
  const jwts = new Map();   // origine -> { jwt, exp } : un JWT par service de push, renouvelé avant expiration (12 h, max 24 h)
  function vapid(origin) {
    const now = Math.floor(Date.now() / 1000), c = jwts.get(origin);
    if (c && c.exp - now > 3600) return c.jwt;
    const exp = now + 12 * 3600;
    const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), p = b64u(JSON.stringify({ aud: origin, exp, sub: subject }));
    const jwt = `${h}.${p}.${b64u(crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }))}`;
    jwts.set(origin, { jwt, exp });
    return jwt;
  }
  return {
    close() {},
    async send(token, { title, body, data = {}, collapseId }) {
      const canon = canonicalSubscription(token, allowHost);
      if (!canon) return { invalid: true };                                   // abonnement illisible ou vers un hôte inconnu : jamais appelé, supprimé
      const { endpoint, keys } = JSON.parse(canon);
      const payload = Buffer.from(JSON.stringify({ title: clip(title, 120), body: clip(body, 400), data, ...(collapseId ? { tag: clip(collapseId, 64) } : {}) }));
      const headers = {
        Authorization: `vapid t=${vapid(new URL(endpoint).origin)}, k=${b64u(pub)}`,
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high',
        ...(collapseId && /^[A-Za-z0-9_-]{1,32}$/.test(collapseId) ? { Topic: collapseId } : {}),
      };
      const res = await fetchImpl(endpoint, { method: 'POST', headers, body: encrypt(payload, fromB64u(keys.p256dh), fromB64u(keys.auth)), signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status === 404 || res.status === 410) return { invalid: true };                // abonnement expiré / désabonné
      if (res.status === 403 || res.status === 401) return { invalid: true };               // abonnement créé avec une autre clé VAPID (ou refusé) : inutilisable
      throw new Error(`webpush_${res.status}`);
    },
  };
}

module.exports = { createWebPush, canonicalSubscription, endpointOk, vapidKeysValid, generateVapidKeys, encrypt };
