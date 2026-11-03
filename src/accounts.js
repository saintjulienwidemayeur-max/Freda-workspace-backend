const crypto = require('crypto');
const { HttpError } = require('./errors');
const { hashPassword, verifyPassword, issueToken, signJwt, verifyJwt } = require('./auth');
const { templates } = require('./mailer');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const id = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const str = (v, max) => String(v ?? '').trim().slice(0, max);

const COMPANY_FIELDS = { company: 'company', taxId: 'tax_id', address: 'address', city: 'city', country: 'country', billingEmail: 'billing_email', phone: 'phone', name: 'name', language: 'language' };

function publicUser(r) {
  return { id: r.id, name: r.name, email: r.email, phone: r.phone, company: r.company, taxId: r.tax_id, address: r.address, city: r.city, country: r.country, billingEmail: r.billing_email, language: r.language };
}

function createAccounts({ cfg, db, mailer, log }) {
  /* Limite les essais de connexion par (IP + e-mail) : 8 échecs / 15 min. */
  const fails = new Map();
  const tooMany = (k) => (fails.get(k) || []).filter((t) => Date.now() - t < 15 * 60 * 1000).length >= 8;
  const noteFail = (k) => fails.set(k, [...(fails.get(k) || []).filter((t) => Date.now() - t < 15 * 60 * 1000), Date.now()]);

  function session(row) { return { token: issueToken(cfg, row), user: publicUser(row) }; }

  async function signup(b) {
    const email = str(b.email, 200).toLowerCase(), name = str(b.name, 120), password = String(b.password || '');
    if (!EMAIL.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.', 'invalid_email');
    if (name.length < 2) throw new HttpError(400, 'Indiquez votre nom.', 'invalid_name');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.', 'weak_password');
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail. Connectez-vous.', 'email_taken');
    const uid = id('usr');
    db.run('INSERT INTO users (id, email, name, phone, password_hash, company, created_at) VALUES (?,?,?,?,?,?,?)', uid, email, name, str(b.phone, 30), hashPassword(password), str(b.company, 120), new Date().toISOString());
    const row = db.get('SELECT * FROM users WHERE id = ?', uid);
    mailer.trySend({ to: email, ...templates.welcome(row, cfg.appUrl) });
    return session(row);
  }

  async function login(b, ip) {
    const email = str(b.email, 200).toLowerCase();
    const key = ip + '|' + email;
    if (tooMany(key)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.', 'too_many_attempts');
    const row = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!verifyPassword(b.password, row && row.password_hash) || !row) { noteFail(key); throw new HttpError(401, 'E-mail ou mot de passe incorrect.', 'invalid_credentials'); }
    return session(row);
  }

  const me = (userId) => publicUser(db.get('SELECT * FROM users WHERE id = ?', userId));

  /** Profil / entreprise : seuls les champs connus sont modifiables. */
  function updateProfile(userId, patch) {
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(COMPANY_FIELDS)) {
      if (patch[k] === undefined) continue;
      let v = str(patch[k], k === 'address' ? 200 : 120);
      if (k === 'billingEmail' && v && !EMAIL.test(v)) throw new HttpError(400, 'Adresse e-mail de facturation invalide.', 'invalid_email');
      if (k === 'name' && v.length < 2) continue;
      sets.push(`${col} = ?`); vals.push(v);
    }
    if (patch.email !== undefined) {
      const e = str(patch.email, 200).toLowerCase();
      if (!EMAIL.test(e)) throw new HttpError(400, 'Adresse e-mail invalide.', 'invalid_email');
      const other = db.get('SELECT id FROM users WHERE email = ? AND id <> ?', e, userId);
      if (other) throw new HttpError(409, 'Cette adresse est déjà utilisée.', 'email_taken');
      sets.push('email = ?'); vals.push(e);
    }
    if (sets.length) db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, userId);
    return me(userId);
  }

  async function changePassword(userId, { oldPassword, newPassword }) {
    const row = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (String(newPassword || '').length < 8) throw new HttpError(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères.', 'weak_password');
    if (row.password_hash && !verifyPassword(oldPassword, row.password_hash)) throw new HttpError(403, 'Mot de passe actuel incorrect.', 'invalid_credentials');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), userId);
    return { ok: true };
  }

  /* ---------- Réinitialisation du mot de passe : toujours la même réponse (pas de fuite sur l'existence du compte) ---------- */
  async function requestReset(emailRaw) {
    const email = str(emailRaw, 200).toLowerCase();
    const row = EMAIL.test(email) && db.get('SELECT * FROM users WHERE email = ?', email);
    if (row) {
      const token = crypto.randomBytes(32).toString('base64url');
      db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)', sha(token), row.id, Date.now() + 3600 * 1000);
      await mailer.trySend({ to: email, ...templates.reset(row, `${cfg.appUrl}/connexion.html?reset=${token}`) });
    }
    return { ok: true };
  }
  async function confirmReset({ token, password }) {
    if (String(password || '').length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.', 'weak_password');
    const r = db.get('SELECT * FROM password_resets WHERE token_hash = ?', sha(String(token || '')));
    if (!r || r.used || r.expires_at < Date.now()) throw new HttpError(400, 'Ce lien est invalide ou a expiré. Demandez-en un nouveau.', 'invalid_token');
    db.tx(() => {
      db.run('UPDATE password_resets SET used = 1 WHERE token_hash = ?', r.token_hash);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), r.user_id);
    });
    return session(db.get('SELECT * FROM users WHERE id = ?', r.user_id));
  }

  /* ---------- Google OAuth 2.0 (code d'autorisation). Apple : non branché (nécessite une clé développeur Apple). ---------- */
  function oauthStart(provider, next) {
    if (provider === 'apple') throw new HttpError(501, 'Apple Sign-In n’est pas encore configuré.', 'oauth_not_configured');
    if (provider !== 'google' || !cfg.google.clientId) throw new HttpError(501, 'Connexion Google non configurée.', 'oauth_not_configured');
    const state = signJwt({ sub: 'oauth-state', n: crypto.randomBytes(8).toString('hex'), next: next && /^[\w./?=&-]+$/.test(next) && !next.startsWith('//') ? next : '', exp: Math.floor(Date.now() / 1000) + 600 }, cfg.auth.jwtSecret);
    const u = new URL(cfg.google.authUrl);
    u.search = new URLSearchParams({ client_id: cfg.google.clientId, redirect_uri: `${cfg.apiUrl}/api/auth/oauth/google/callback`, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
    return u.toString();
  }
  async function oauthCallback(provider, { code, state }) {
    if (provider !== 'google') throw new HttpError(501, 'Fournisseur non pris en charge.', 'oauth_not_configured');
    let st;
    try { st = verifyJwt(state, cfg.auth.jwtSecret); } catch (e) { throw new HttpError(400, 'État OAuth invalide ou expiré.', 'invalid_state'); }
    const tok = await fetch(cfg.google.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret, redirect_uri: `${cfg.apiUrl}/api/auth/oauth/google/callback`, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(15000) });
    if (!tok.ok) throw new HttpError(400, 'Connexion Google refusée.', 'oauth_failed');
    const { access_token } = await tok.json();
    const info = await fetch(cfg.google.userInfoUrl, { headers: { Authorization: 'Bearer ' + access_token }, signal: AbortSignal.timeout(15000) });
    if (!info.ok) throw new HttpError(400, 'Connexion Google refusée.', 'oauth_failed');
    const p = await info.json();
    if (!p.sub || !p.email || p.email_verified === false) throw new HttpError(400, 'Adresse e-mail Google non vérifiée.', 'oauth_failed');
    const email = String(p.email).toLowerCase();
    let ident = db.get('SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?', 'google', String(p.sub));
    let row;
    if (ident) row = db.get('SELECT * FROM users WHERE id = ?', ident.user_id);
    else {
      row = db.get('SELECT * FROM users WHERE email = ?', email);       // e-mail vérifié par Google : rattaché au compte existant
      if (!row) {
        const uid = id('usr');
        db.run('INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)', uid, email, str(p.name, 120) || email.split('@')[0], new Date().toISOString());
        row = db.get('SELECT * FROM users WHERE id = ?', uid);
        mailer.trySend({ to: email, ...templates.welcome(row, cfg.appUrl) });
      }
      db.run('INSERT INTO oauth_identities (provider, subject, user_id) VALUES (?,?,?)', 'google', String(p.sub), row.id);
    }
    return { token: issueToken(cfg, row), next: st.next || '', isNew: !ident };
  }

  /* ---------- Moyens de paiement enregistrés (MonCash / NatCash par numéro ; cartes : nécessitent un processeur PCI, pas encore branché) ---------- */
  const mask = (phone) => '+509 ' + phone.slice(3, 5) + '•• ••' + phone.slice(-2);
  function listMethods(userId) {
    return db.all('SELECT * FROM payment_methods WHERE user_id = ? ORDER BY is_default DESC, created_at', userId).map((m) => ({ id: m.id, type: m.type, phone: m.phone ? mask(m.phone) : '', brand: m.brand, last4: m.last4, exp: m.exp, default: !!m.is_default }));
  }
  function addMethod(userId, b) {
    if (b.type === 'card') throw new HttpError(400, 'Une carte s’enregistre automatiquement lors de votre premier paiement par carte (saisie sécurisée chez Stripe).', 'card_via_payment');
    if (!['moncash', 'natcash'].includes(b.type)) throw new HttpError(400, 'Moyen de paiement inconnu.', 'invalid_method');
    const digits = String(b.phone || '').replace(/\D/g, '');
    const phone = digits.length === 8 ? '509' + digits : digits;
    if (!/^509\d{8}$/.test(phone)) throw new HttpError(400, 'Numéro invalide (8 chiffres, indicatif +509).', 'invalid_phone');
    if (db.get('SELECT 1 FROM payment_methods WHERE user_id = ? AND type = ? AND phone = ?', userId, b.type, phone)) throw new HttpError(409, 'Ce numéro est déjà enregistré.', 'duplicate');
    const first = !db.get('SELECT 1 FROM payment_methods WHERE user_id = ?', userId);
    db.run('INSERT INTO payment_methods (id, user_id, type, phone, is_default, created_at) VALUES (?,?,?,?,?,?)', id('pm'), userId, b.type, phone, first ? 1 : 0, new Date().toISOString());
    return listMethods(userId);
  }
  function setDefaultMethod(userId, mid) {
    if (!db.get('SELECT 1 FROM payment_methods WHERE id = ? AND user_id = ?', mid, userId)) throw new HttpError(404, 'Moyen de paiement introuvable.', 'not_found');
    db.tx(() => { db.run('UPDATE payment_methods SET is_default = 0 WHERE user_id = ?', userId); db.run('UPDATE payment_methods SET is_default = 1 WHERE id = ?', mid); });
    return listMethods(userId);
  }
  function removeMethod(userId, mid) {
    const m = db.get('SELECT * FROM payment_methods WHERE id = ? AND user_id = ?', mid, userId);
    if (!m) throw new HttpError(404, 'Moyen de paiement introuvable.', 'not_found');
    db.tx(() => {
      db.run('DELETE FROM payment_methods WHERE id = ?', mid);
      if (m.is_default) db.run('UPDATE payment_methods SET is_default = 1 WHERE id = (SELECT id FROM payment_methods WHERE user_id = ? ORDER BY created_at LIMIT 1)', userId);
    });
    return listMethods(userId);
  }

  return { signup, login, me, updateProfile, changePassword, requestReset, confirmReset, oauthStart, oauthCallback, listMethods, addMethod, setDefaultMethod, removeMethod };
}

module.exports = { createAccounts, publicUser };
