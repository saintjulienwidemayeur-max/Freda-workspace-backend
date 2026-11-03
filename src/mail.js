/**
 * Freda Mail : boîtes et alias (Purelymail).
 *
 * Adaptateur aligné sur la spécification OpenAPI de l'API v0 (POST JSON, en-tête « Purelymail-Api-Token », succès { result }, erreur { type: 'error', code, message } —
 * format d'erreur et chemin /api/v0/* vérifiés contre purelymail.com). Points importants :
 *  - deleteUser attend l'adresse COMPLÈTE (user@domaine) ; createUser attend la partie locale + domainName ;
 *  - createRoutingRule : prefix = booléen, matchUser = partie locale ; la réponse est VIDE (pas d'id) -> on relit listRoutingRules ;
 *  - un domaine doit être ajouté (addDomain) APRÈS publication du TXT de propriété (getOwnershipCode) avant tout createUser.
 * Sans PURELYMAIL_API_KEY, les boîtes sont enregistrées avec provider_status = 'pending_provider' (non utilisables) et le client est prévenu.
 */
const crypto = require('crypto');
const { HttpError } = require('./errors');

const LOCAL = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const id = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

function createPurelymail(cfg, log) {
  const enabled = !!cfg.purelymail.apiKey;
  async function call(endpoint, body) {
    const res = await fetch(`${cfg.purelymail.baseUrl.replace(/\/$/, '')}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Purelymail-Api-Token': cfg.purelymail.apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    let data = {};
    try { data = await res.json(); } catch (e) { /* corps non JSON */ }
    if (!res.ok || data.type === 'error') { log('error', 'purelymail_failed', { endpoint, status: res.status, code: data.code }); throw new HttpError(502, 'Le serveur de messagerie n’a pas accepté la demande. Réessayez.', 'mail_provider_error'); }
    return data.result || {};
  }
  return {
    enabled,
    listDomains: async () => ((await call('listDomains', { includeShared: false })).domains || []).map((d) => String(d.name).toLowerCase()),
    ownershipCode: async () => String((await call('getOwnershipCode', {})).code || ''),
    addDomain: (domain) => call('addDomain', { domainName: domain }),
    createUser: ({ local, domain, password }) => call('createUser', { userName: local, domainName: domain, password, enablePasswordReset: false, enableSearchIndexing: true, sendWelcomeEmail: false }),
    /** Mot de passe imposé : sert à BLOQUER l'accès (suspension) ou à rouvrir la boîte (réactivation) sans toucher aux messages. */
    setPassword: ({ local, domain, password }) => call('modifyUser', { userName: `${local}@${domain}`, newPassword: password }),
    deleteUser: ({ local, domain }) => call('deleteUser', { userName: `${local}@${domain}` }),
    /** La réponse de createRoutingRule est vide : on retrouve la règle créée pour pouvoir la supprimer plus tard. */
    async createRoutingRule({ domain, local, targets }) {
      await call('createRoutingRule', { domainName: domain, prefix: false, matchUser: local, targetAddresses: targets, catchall: false });
      const rules = (await call('listRoutingRules', {})).rules || [];
      const hit = rules.filter((r) => String(r.domainName).toLowerCase() === domain && r.matchUser === local && !r.prefix && !r.catchall).sort((a, b) => b.id - a.id)[0];
      return { id: hit ? hit.id : '' };
    },
    deleteRoutingRule: (ref) => call('deleteRoutingRule', { routingRuleId: Number(ref) }),
  };
}

function createMail({ cfg, db, log, provider, dns }) {
  const pm = provider || createPurelymail(cfg, log);
  const box = (r) => ({ id: r.id, address: r.address, name: r.name, usedGb: r.used_gb, created: r.created_at.slice(0, 10), lastLogin: r.last_login ? r.last_login.slice(0, 10) : null, role: r.role, status: r.provider_status });
  const alias = (r) => ({ id: r.id, from: r.from_addr, to: r.to_addr });

  const subscription = (userId) => {
    const s = db.get("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','past_due')", userId);
    if (!s) throw new HttpError(402, 'Activez une offre Freda Mail pour créer des boîtes.', 'no_subscription');
    return s;
  };
  const ownDomain = (userId, domain) => {
    const d = db.get("SELECT * FROM domains WHERE user_id = ? AND name = ? AND status IN ('active','pending')", userId, String(domain || '').toLowerCase());
    if (!d) throw new HttpError(404, 'Domaine introuvable dans votre espace.', 'not_found');
    return d;
  };

  /**
   * Garantit que le domaine existe chez Purelymail : publie le TXT de propriété (zone gérée par Freda) puis addDomain.
   * Le DNS met parfois quelques minutes à se propager : tant que Purelymail refuse, on répond 409 (réessayer) sans créer de boîte fantôme.
   */
  async function ensureProviderDomain(userId, d) {
    if (!pm.enabled) return;
    if ((await pm.listDomains()).includes(d.name)) return;
    const code = await pm.ownershipCode();
    if (code && dns) await dns.ensureOwnership(userId, d.name, code);
    try { await pm.addDomain(d.name); }
    catch (e) {
      if (!(e instanceof HttpError)) throw e;
      log('warn', 'purelymail_domain_pending', { domain: d.name });
      throw new HttpError(409, `Le domaine ${d.name} est en cours de vérification (propagation DNS, jusqu’à 15 minutes). Réessayez dans quelques minutes.`, 'domain_pending_verification');
    }
  }

  const listBoxes = (userId) => db.all('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY created_at', userId).map(box);
  const listAliases = (userId) => db.all('SELECT * FROM aliases WHERE user_id = ? ORDER BY from_addr', userId).map(alias);

  /** Crée une boîte. Le mot de passe initial n'est renvoyé QU'ICI (jamais stocké). */
  async function createBox(userId, { local, domain, name }) {
    const sub = subscription(userId);
    const lp = String(local || '').trim().toLowerCase();
    if (!LOCAL.test(lp)) throw new HttpError(400, 'Nom de boîte invalide (lettres, chiffres, point, tiret).', 'invalid_local');
    const d = ownDomain(userId, domain);
    const plan = cfg.plans[sub.plan];
    const count = db.get('SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?', userId).n;
    if (count >= plan.mailboxes) throw new HttpError(403, `Votre offre ${plan.name} est limitée à ${plan.mailboxes} boîte${plan.mailboxes > 1 ? 's' : ''}. Passez à une offre supérieure.`, 'plan_limit');
    const address = `${lp}@${d.name}`;
    if (db.get('SELECT 1 FROM mailboxes WHERE address = ?', address) || db.get('SELECT 1 FROM aliases WHERE from_addr = ?', address)) throw new HttpError(409, 'Cette adresse existe déjà.', 'duplicate');
    const password = crypto.randomBytes(12).toString('base64url');
    let status = 'pending_provider';
    if (pm.enabled) { await ensureProviderDomain(userId, d); await pm.createUser({ local: lp, domain: d.name, password }); status = 'active'; }
    const bid = id('mbx');
    db.run('INSERT INTO mailboxes (id, user_id, domain, local_part, address, name, role, provider_status, created_at) VALUES (?,?,?,?,?,?,?,?,?)', bid, userId, d.name, lp, address, String(name || lp).trim().slice(0, 80), count === 0 ? 'Propriétaire' : 'Utilisateur', status, new Date().toISOString());
    db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'mail-plus', `Boîte ${address} créée`, now());
    return { mailbox: box(db.get('SELECT * FROM mailboxes WHERE id = ?', bid)), initialPassword: status === 'active' ? password : null, providerReady: status === 'active' };
  }

  async function removeBox(userId, boxId) {
    const b = db.get('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?', String(boxId), userId);
    if (!b) throw new HttpError(404, 'Boîte introuvable.', 'not_found');
    if (b.role === 'Propriétaire' && db.get('SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?', userId).n > 1) throw new HttpError(400, 'Supprimez d’abord les autres boîtes ou transférez la propriété.', 'owner_box');
    if (pm.enabled && b.provider_status !== 'pending_provider') await pm.deleteUser({ local: b.local_part, domain: b.domain });
    db.tx(() => {
      for (const a of db.all('SELECT * FROM aliases WHERE user_id = ? AND to_addr = ?', userId, b.address)) db.run('DELETE FROM aliases WHERE id = ?', a.id);
      db.run('DELETE FROM mailboxes WHERE id = ?', b.id);
    });
    return { ok: true };
  }

  async function addAlias(userId, { from, to }) {
    subscription(userId);
    const f = String(from || '').trim().toLowerCase(), t = String(to || '').trim().toLowerCase();
    const m = /^([^@\s]+)@([^@\s]+)$/.exec(f);
    if (!m || !LOCAL.test(m[1])) throw new HttpError(400, 'Adresse d’alias invalide.', 'invalid_alias');
    ownDomain(userId, m[2]);
    const target = db.get('SELECT * FROM mailboxes WHERE user_id = ? AND address = ?', userId, t);
    if (!target) throw new HttpError(400, 'La destination doit être l’une de vos boîtes.', 'invalid_target');
    if (db.get('SELECT 1 FROM mailboxes WHERE address = ?', f) || db.get('SELECT 1 FROM aliases WHERE from_addr = ?', f)) throw new HttpError(409, 'Cette adresse existe déjà.', 'duplicate');
    let ref = '';
    if (pm.enabled && target.provider_status === 'active') ref = String((await pm.createRoutingRule({ domain: m[2], local: m[1], targets: [t] })).id || '');
    const aid = id('als');
    db.run('INSERT INTO aliases (id, user_id, from_addr, to_addr, provider_ref) VALUES (?,?,?,?,?)', aid, userId, f, t, ref);
    return alias(db.get('SELECT * FROM aliases WHERE id = ?', aid));
  }
  async function removeAlias(userId, aliasId) {
    const a = db.get('SELECT * FROM aliases WHERE id = ? AND user_id = ?', String(aliasId), userId);
    if (!a) throw new HttpError(404, 'Alias introuvable.', 'not_found');
    if (pm.enabled && a.provider_ref) await pm.deleteRoutingRule(a.provider_ref);
    db.run('DELETE FROM aliases WHERE id = ?', a.id);
    return { ok: true };
  }

  const secret = () => crypto.randomBytes(18).toString('base64url');

  /**
   * Suspension (offre impayée ou résiliée) : l'accès est bloqué en remplaçant le mot de passe par un secret aléatoire jamais conservé ;
   * les messages sont gardés et le courrier entrant continue d'arriver. Rien n'est supprimé. Les échecs restent « active » et sont retentés au passage suivant.
   */
  async function suspendMailboxes(userId) {
    let suspended = 0, failed = 0;
    for (const b of db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'active'", userId)) {
      try {
        if (pm.enabled) await pm.setPassword({ local: b.local_part, domain: b.domain, password: secret() });
        db.run("UPDATE mailboxes SET provider_status = 'suspended' WHERE id = ?", b.id); suspended++;
      } catch (e) { failed++; log('warn', 'mailbox_suspend_failed', { mailbox: b.address }); }
    }
    return { suspended, failed };
  }

  /** Réactivation après paiement : nouveau mot de passe par boîte (renvoyé UNE fois, jamais stocké). Une boîte en échec reste suspendue et sera retentée. */
  async function reactivateMailboxes(userId) {
    const mailboxes = []; let failed = 0;
    for (const b of db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'suspended'", userId)) {
      const password = secret();
      try {
        if (pm.enabled) await pm.setPassword({ local: b.local_part, domain: b.domain, password });
        db.run("UPDATE mailboxes SET provider_status = 'active' WHERE id = ?", b.id);
        mailboxes.push({ address: b.address, password });
      } catch (e) { failed++; log('warn', 'mailbox_reactivate_failed', { mailbox: b.address }); }
    }
    return { mailboxes, failed };
  }

  return { listBoxes, listAliases, createBox, removeBox, addAlias, removeAlias, suspendMailboxes, reactivateMailboxes, providerEnabled: pm.enabled };
}

module.exports = { createMail, createPurelymail };
