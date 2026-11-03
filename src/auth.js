/** Mots de passe (scrypt) et jetons JWT HS256 (compatibles avec ce que le frontend envoie en « Authorization: Bearer »). */
const crypto = require('crypto');
const { HttpError } = require('./errors');

class AuthError extends HttpError { constructor(msg = 'Authentification requise.') { super(401, msg, 'unauthorized'); this.name = 'AuthError'; } }

/* ---------- mots de passe ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(password, stored) {
  const [scheme, s, h] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !s || !h) { crypto.scryptSync('x', 'x', 32); return false; }   // temps constant même si le compte n'a pas de mot de passe
  const expected = Buffer.from(h, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(s, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

/* ---------- JWT ---------- */
const b64 = (s) => Buffer.from(s, 'base64url');
function signJwt(payload, secret) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return h + '.' + p + '.' + crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
}
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
  return payload;
}

/** Fabrique le jeton de session d'un utilisateur. */
function issueToken(cfg, user) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: user.id, email: user.email, iat: now, exp: now + cfg.auth.tokenTtlHours * 3600 }, cfg.auth.jwtSecret);
}

/**
 * Jeton de session d'une BOÎTE (application mobile) : ne donne accès qu'aux routes /api/mail/* de cette boîte, jamais au compte Freda
 * (son « sub » n'est pas un utilisateur : le jeton de compte et celui de boîte ne sont pas interchangeables). Invalidé par tokens_valid_after.
 */
function issueMailboxToken(cfg, mailbox) {
  const now = Date.now();
  return signJwt({ sub: 'mbx:' + mailbox.id, typ: 'mbx', mb: mailbox.id, iatMs: now, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + cfg.push.sessionDays * 86400 }, cfg.auth.jwtSecret);
}
function createMailboxAuthenticator(cfg, db) {
  return function authenticateMailbox(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new AuthError();
    const p = verifyJwt(m[1], cfg.auth.jwtSecret);
    if (p.typ !== 'mbx' || !p.mb) throw new AuthError();
    const b = db.get('SELECT * FROM mailboxes WHERE id = ?', String(p.mb));
    if (!b || b.provider_status !== 'active' || !(p.iatMs > b.tokens_valid_after)) throw new AuthError('Session expirée : reconnectez-vous.');
    return b;
  };
}

/** Retourne authenticate(req) -> { id, email }. En mode « demo » (développement uniquement) l'en-tête X-Demo-User crée/charge l'utilisateur. */
function createAuthenticator(cfg, db) {
  return function authenticate(req) {
    if (cfg.auth.mode === 'demo') {
      const email = String(req.headers['x-demo-user'] || '').toLowerCase();
      if (!email) throw new AuthError();
      let u = db.get('SELECT id, email FROM users WHERE email = ?', email);
      if (!u) {
        const id = 'usr_' + crypto.randomBytes(8).toString('hex');
        db.run('INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)', id, email, email.split('@')[0], new Date().toISOString());
        u = { id, email };
      }
      return u;
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new AuthError();
    const payload = verifyJwt(m[1], cfg.auth.jwtSecret);
    const u = db.get('SELECT id, email FROM users WHERE id = ?', String(payload.sub));
    if (!u) throw new AuthError();                                      // compte supprimé : jeton refusé
    return u;
  };
}

module.exports = { AuthError, hashPassword, verifyPassword, signJwt, verifyJwt, issueToken, createAuthenticator, issueMailboxToken, createMailboxAuthenticator };
