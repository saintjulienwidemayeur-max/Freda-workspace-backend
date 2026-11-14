/**
 * Clés API personnelles d'une boîte Freda Mail (« Intégrations & API » dans les paramètres du webmail).
 *
 * Sécurité :
 *  - une clé = 32 octets aléatoires (fmk_ + base64url) montrés UNE SEULE FOIS à la création ; la base ne garde que son empreinte HMAC-SHA256 (sous-clé de DATA_KEY :
 *    une base volée seule ne permet rien) et un préfixe de 8 caractères pour que l'utilisateur reconnaisse la clé dans la liste ;
 *  - une clé n'agit que sur SA boîte, avec une portée : « read » (lecture seule) ou « read_send » (lecture + envoi) ;
 *  - création / suppression des clés et du webhook : uniquement avec la session de la boîte (webmail), jamais avec une clé API (une clé volée ne peut ni créer d'autres clés
 *    ni détourner le courrier vers un webhook) ;
 *  - une clé créée AVANT le dernier changement de mot de passe de la boîte est refusée (comme les sessions) ; boîte suspendue / abonnement inactif : refusé ;
 *  - l'accès IMAP / SMTP se fait avec un mot de passe d'application Purelymail « Freda API » (jamais le mot de passe du client), chiffré au repos, révoqué quand
 *    il n'y a plus ni clé ni webhook.
 */
const crypto = require('crypto');
const { HttpError } = require('./errors');

const MAX_KEYS = 10;
const SCOPES = ['read', 'read_send'];
const KEY_RE = /^fmk_[A-Za-z0-9_-]{43}$/;
const unauthorized = (msg = 'Clé API invalide.') => new HttpError(401, msg, 'invalid_api_key');

function createApiKeys({ cfg, db, vault, mail, log }) {
  const pm = mail.provider;
  const providerLocal = (b) => b.provider_user || b.local_part;
  const locks = new Map();
  async function locked(key, fn) { const prev = locks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(key, next.catch(() => {})); return next; }
  const hash = (k) => vault.mac('api-key', k);
  const view = (r) => ({ id: r.id, name: r.name, scope: r.scope, prefix: r.key_prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at || null });

  /** Mot de passe d'application « Freda API » de la boîte (créé à la demande, un seul par boîte). */
  async function ensureCredential(b) {
    return await locked('cred:' + b.id, async () => {
      if (await db.get('SELECT 1 FROM api_credentials WHERE mailbox_id = ?', b.id)) return;
      const secret = await pm.createAppPassword({ local: providerLocal(b), domain: b.domain, name: 'Freda API' });
      if (!secret) throw new HttpError(502, 'Le serveur de messagerie n’a pas fourni d’identifiant. Réessayez.', 'mail_provider_error');
      await db.run('INSERT INTO api_credentials (mailbox_id, secret_enc, created_at) VALUES (?,?,?)', b.id, vault.encrypt(secret), new Date().toISOString());
    });
  }
  async function credentialFor(b) {
    const r = await db.get('SELECT secret_enc FROM api_credentials WHERE mailbox_id = ?', b.id);
    if (!r) return null;
    return { user: b.address, pass: vault.decrypt(r.secret_enc) };
  }
  /** Révoque l'identifiant chez Purelymail quand plus rien ne l'utilise (aucune clé, aucun webhook). En cas d'échec : réessayé au prochain passage. */
  async function releaseCredential(b) {
    return await locked('cred:' + b.id, async () => {
      if ((await db.get('SELECT COUNT(*) AS n FROM api_keys WHERE mailbox_id = ?', b.id)).n > 0) return;
      if (await db.get('SELECT 1 FROM api_webhooks WHERE mailbox_id = ?', b.id)) return;
      const c = await db.get('SELECT secret_enc FROM api_credentials WHERE mailbox_id = ?', b.id);
      if (!c) return;
      try { await pm.deleteAppPassword({ local: providerLocal(b), domain: b.domain, appPassword: vault.decrypt(c.secret_enc) }); }
      catch (e) { log('warn', 'api_credential_cleanup_failed', { mailbox: b.id }); return; }
      await db.run('DELETE FROM api_credentials WHERE mailbox_id = ?', b.id);
    });
  }

  async function list(b) {
    return (await db.all('SELECT * FROM api_keys WHERE mailbox_id = ? ORDER BY created_ms DESC', b.id)).map(view);
  }

  async function create(b, { name, scope } = {}) {
    const n = String(name ?? '').trim();
    if (!n || n.length > 60 || /[\u0000-\u001f\u007f]/.test(n)) throw new HttpError(400, 'Donnez un nom à la clé (60 caractères maximum).', 'invalid_name');
    const sc = scope === undefined ? 'read' : scope;
    if (!SCOPES.includes(sc)) throw new HttpError(400, 'Portée inconnue : « read » (lecture seule) ou « read_send » (lecture et envoi).', 'invalid_scope');
    if (!mail.providerEnabled) throw new HttpError(503, 'La messagerie est en cours d’activation. Réessayez dans quelques minutes.', 'mailbox_not_ready');
    if ((await db.get('SELECT COUNT(*) AS n FROM api_keys WHERE mailbox_id = ?', b.id)).n >= MAX_KEYS) throw new HttpError(409, `Limite de ${MAX_KEYS} clés atteinte : supprimez une clé inutilisée.`, 'too_many_keys');
    try { await ensureCredential(b); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'Le serveur de messagerie n’a pas accepté la demande. Réessayez.', 'mail_provider_error'); }
    const key = 'fmk_' + crypto.randomBytes(32).toString('base64url');
    const id = 'key_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    await db.run('INSERT INTO api_keys (id, mailbox_id, name, scope, key_prefix, key_hash, created_at, created_ms) VALUES (?,?,?,?,?,?,?,?)', id, b.id, n, sc, key.slice(0, 12), hash(key), new Date(now).toISOString(), now);
    log('info', 'api_key_created', { mailbox: b.address, scope: sc });
    return { ...view(await db.get('SELECT * FROM api_keys WHERE id = ?', id)), key };   // la clé complète n'est renvoyée qu'ici
  }

  async function remove(b, keyId) {
    const r = await db.run('DELETE FROM api_keys WHERE id = ? AND mailbox_id = ?', String(keyId), b.id);
    if (!r.changes) throw new HttpError(404, 'Clé introuvable.', 'not_found');
    log('info', 'api_key_deleted', { mailbox: b.address });
    await releaseCredential(b);
    return { ok: true };
  }

  /** Clé présentée -> { key, mailbox } ; sinon 401 (402 si l'abonnement n'est plus actif). Ne révèle jamais pourquoi une clé est refusée. */
  async function authenticate(token) {
    if (!KEY_RE.test(String(token || ''))) throw unauthorized();
    const k = await db.get('SELECT * FROM api_keys WHERE key_hash = ?', hash(token));
    if (!k) throw unauthorized();
    const b = await db.get('SELECT * FROM mailboxes WHERE id = ?', k.mailbox_id);
    if (!b || b.provider_status !== 'active' || !(Number(k.created_ms) > Number(b.tokens_valid_after))) throw unauthorized();
    const sub = await db.get('SELECT status FROM subscriptions WHERE user_id = ?', b.user_id);
    if (sub && ['suspended', 'cancelled'].includes(sub.status)) throw new HttpError(402, 'Votre abonnement email n’est plus actif.', 'no_subscription');
    if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60_000) db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', new Date().toISOString(), k.id).catch(() => {});
    return { key: k, mailbox: b };
  }

  return { list, create, remove, authenticate, ensureCredential, credentialFor, releaseCredential, providerReady: () => !!mail.providerEnabled, MAX_KEYS, SCOPES };
}

module.exports = { createApiKeys };
