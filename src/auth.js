/** Authentification : jeton JWT HS256 (compatible Supabase : JWT_SECRET = « JWT secret » du projet). */
const crypto = require('crypto');

class AuthError extends Error { constructor(msg = 'Authentification requise.') { super(msg); this.name = 'AuthError'; this.status = 401; } }

const b64 = (s) => Buffer.from(s, 'base64url');

function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError();
  const [h, p, s] = parts;
  let header, payload;
  try { header = JSON.parse(b64(h).toString()); payload = JSON.parse(b64(p).toString()); } catch (e) { throw new AuthError(); }
  if (header.alg !== 'HS256') throw new AuthError();                     // pas d'« alg: none »
  const expected = crypto.createHmac('sha256', secret).update(h + '.' + p).digest();
  const given = b64(s);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new AuthError();
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new AuthError('Session expirée.');
  if (!payload.sub) throw new AuthError();
  return { id: String(payload.sub), email: payload.email || '' };
}

function createAuth(cfg) {
  return function authenticate(req) {
    if (cfg.auth.mode === 'demo') {                                      // développement local uniquement
      const email = req.headers['x-demo-user'];
      if (!email) throw new AuthError();
      return { id: 'demo:' + email, email };
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new AuthError();
    return verifyJwt(m[1], cfg.auth.jwtSecret);
  };
}

function signJwt(payload, secret) {   // utilitaire (tests, scripts)
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return h + '.' + p + '.' + crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
}

module.exports = { createAuth, verifyJwt, signJwt, AuthError };
