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
const { templates } = require('./mailer');

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
    /** modifyUser : nouveau mot de passe et/ou nouveau nom (renommer change l'identifiant de connexion IMAP/SMTP/webmail, donc invalide aussi les mots de passe d'application). */
    modifyUser: ({ local, domain, newLocal, password }) => call('modifyUser', { userName: `${local}@${domain}`, ...(newLocal ? { newUserName: `${newLocal}@${domain}` } : {}), ...(password ? { newPassword: password } : {}) }),
    createAppPassword: async ({ local, domain, name }) => String((await call('createAppPassword', { userHandle: `${local}@${domain}`, name })).appPassword || ''),
    deleteAppPassword: ({ local, domain, appPassword }) => call('deleteAppPassword', { userName: `${local}@${domain}`, appPassword }),
    async findRules({ domain, local, target }) {
      const rules = (await call('listRoutingRules', {})).rules || [];
      return rules.filter((r) => String(r.domainName).toLowerCase() === domain && r.matchUser === local && !r.prefix && !r.catchall && (!target || (r.targetAddresses || []).includes(target)));
    },
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

function createMail({ cfg, db, log, provider, dns, vault, mailer }) {
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
    if (pm.enabled && b.provider_status !== 'pending_provider') {
      if (b.provider_user) await dropSuspendRules(b, b.provider_user);
      await pm.deleteUser({ local: providerLocal(b), domain: b.domain });
    }
    db.run('DELETE FROM devices WHERE mailbox_id = ?', b.id);   // les mots de passe d'application disparaissent avec l'utilisateur
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
  const renameMode = cfg.purelymail.suspendMode === 'rename';
  const providerLocal = (b) => b.provider_user || b.local_part;

  /** Courrier entrant d'une boîte suspendue : l'adresse d'origine est redirigée vers la boîte renommée (rien n'est perdu, rien n'est lisible par le client). */
  async function ensureSuspendRule(b) {
    if (!pm.enabled || !b.provider_user) return true;
    try {
      const target = `${b.provider_user}@${b.domain}`;
      if (!(await pm.findRules({ domain: b.domain, local: b.local_part, target })).length) await pm.createRoutingRule({ domain: b.domain, local: b.local_part, targets: [target] });
      db.run("UPDATE mailboxes SET rule_state = 'set' WHERE id = ?", b.id); return true;
    } catch (e) { log('warn', 'suspend_rule_failed', { mailbox: b.address }); return false; }
  }
  async function dropSuspendRules(b, alias) {
    if (!pm.enabled) return true;
    try {
      for (const r of await pm.findRules({ domain: b.domain, local: b.local_part, target: alias ? `${alias}@${b.domain}` : undefined })) await pm.deleteRoutingRule(r.id);
      return true;
    } catch (e) { log('warn', 'suspend_rule_cleanup_failed', { mailbox: b.address }); return false; }
  }

  /**
   * Suspension (offre impayée ou résiliée). Mode « rename » (défaut) : en UN appel modifyUser, la boîte est renommée (susp-xxxx) ET reçoit un secret aléatoire jamais conservé.
   * L'identifiant de connexion change donc : mot de passe principal, mots de passe d'application et sessions webmail de l'ancienne adresse cessent tous de fonctionner,
   * le client ne connaît pas le nouveau nom. Le courrier entrant est redirigé vers la boîte renommée : messages conservés, rien n'est supprimé.
   * Mode « password » (MAIL_SUSPEND_MODE=password) : seul le mot de passe change (ne révoque PAS les mots de passe d'application). Les échecs sont retentés au passage suivant.
   */
  async function suspendMailboxes(userId) {
    let suspended = 0, failed = 0;
    for (const b of db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'active'", userId)) {
      try {
        const alias = renameMode ? 'susp-' + crypto.randomBytes(5).toString('hex') : '';
        if (pm.enabled) await pm.modifyUser({ local: b.local_part, domain: b.domain, newLocal: alias || undefined, password: secret() });
        db.run("UPDATE mailboxes SET provider_status = 'suspended', provider_user = ?, rule_state = ? WHERE id = ?", alias, alias ? 'pending' : '', b.id);
        suspended++;
      } catch (e) { failed++; log('warn', 'mailbox_suspend_failed', { mailbox: b.address }); }
    }
    for (const b of db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'suspended' AND rule_state = 'pending'", userId)) if (!(await ensureSuspendRule(b))) failed++;
    return { suspended, failed };
  }

  /** Réactivation après paiement : l'ancien nom est rétabli (les appareils déjà configurés refonctionnent) et un NOUVEAU mot de passe est posé, renvoyé UNE fois, jamais stocké. */
  async function reactivateMailboxes(userId) {
    const mailboxes = []; let failed = 0;
    for (const b of db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'suspended'", userId)) {
      const password = secret();
      try {
        if (pm.enabled) await pm.modifyUser({ local: providerLocal(b), domain: b.domain, newLocal: b.provider_user ? b.local_part : undefined, password });
        db.run("UPDATE mailboxes SET provider_status = 'active', provider_user = '', rule_state = ? WHERE id = ?", b.provider_user ? 'cleanup' : '', b.id);
        mailboxes.push({ address: b.address, password });
      } catch (e) { failed++; log('warn', 'mailbox_reactivate_failed', { mailbox: b.address }); }
    }
    await reconcileRules(userId);
    return { mailboxes, failed };
  }

  /** Règles de routage de suspension : posées pour les boîtes suspendues, retirées pour les boîtes réactivées (retentées tant que nécessaire). */
  async function reconcileRules(userId) {
    let failed = 0;
    for (const b of db.all("SELECT * FROM mailboxes WHERE user_id = ? AND rule_state IN ('pending','cleanup')", userId)) {
      if (b.rule_state === 'pending' && b.provider_status === 'suspended') { if (!(await ensureSuspendRule(b))) failed++; }
      else if (b.rule_state === 'cleanup' && b.provider_status === 'active') { if (await dropSuspendRules(b)) db.run("UPDATE mailboxes SET rule_state = '' WHERE id = ?", b.id); else failed++; }
    }
    return { failed };
  }

  /* ---------- Appareils (applications mobiles iPhone / Android) ---------- */
  /** Réglages IMAP / SMTP publiés par Purelymail (https://purelymail.com/docs/setup/technical). */
  const connection = () => ({
    imap: { host: 'imap.purelymail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.purelymail.com', port: 465, security: 'ssl', alternative: { port: 587, security: 'starttls' } },
  });
  const device = (r, address) => ({ id: r.id, name: r.name, platform: r.platform, mailbox: address, created: r.created_at.slice(0, 10) });
  const listDevices = (userId) => db.all('SELECT d.*, m.address FROM devices d JOIN mailboxes m ON m.id = d.mailbox_id WHERE d.user_id = ? ORDER BY d.created_at', userId).map((r) => device(r, r.address));

  /**
   * Autorise un appareil : crée un mot de passe d'application PROPRE à cet appareil (jamais le mot de passe de la boîte). Il n'est renvoyé qu'ICI, une seule fois ;
   * l'application le range dans le Keychain (iOS) / Keystore (Android). Chiffré côté serveur uniquement pour pouvoir le révoquer.
   * Boîte suspendue : refusé (le renommage de la suspension rend de toute façon les anciens appareils inutilisables ; ils refonctionnent à la réactivation).
   */
  async function addDevice(userId, boxId, { name, platform } = {}) {
    const b = db.get('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?', String(boxId), userId);
    if (!b) throw new HttpError(404, 'Boîte introuvable.', 'not_found');
    subscription(userId);
    if (b.provider_status === 'suspended') throw new HttpError(409, 'Cette boîte est suspendue : réglez votre offre pour la réactiver.', 'mailbox_suspended');
    if (b.provider_status !== 'active' || !pm.enabled) throw new HttpError(503, 'La messagerie est en cours d’activation. Réessayez dans quelques minutes.', 'mailbox_not_ready');
    const label = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (label.length < 1) throw new HttpError(400, 'Donnez un nom à cet appareil (ex. « iPhone de Claire »).', 'invalid_device');
    const plat = ['ios', 'android'].includes(platform) ? platform : 'other';
    if (db.get('SELECT COUNT(*) AS n FROM devices WHERE mailbox_id = ?', b.id).n >= cfg.maxDevicesPerMailbox) throw new HttpError(403, `Limite de ${cfg.maxDevicesPerMailbox} appareils par boîte atteinte. Retirez-en un.`, 'device_limit');
    const appPassword = await pm.createAppPassword({ local: b.local_part, domain: b.domain, name: `Freda · ${label}` });
    if (!appPassword) throw new HttpError(502, 'Le serveur de messagerie n’a pas fourni de mot de passe d’appareil. Réessayez.', 'mail_provider_error');
    const did = id('dev');
    db.run('INSERT INTO devices (id, user_id, mailbox_id, name, platform, secret_enc, created_at) VALUES (?,?,?,?,?,?,?)', did, userId, b.id, label, plat, vault.encrypt(appPassword), new Date().toISOString());
    db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'smartphone', `Appareil « ${label} » autorisé sur ${b.address}`, now());
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (mailer) mailer.trySend({ to: u.email, ...templates.deviceAdded(u, b.address, label, `${cfg.appUrl}/espace/emails.html`) });
    return { device: device(db.get('SELECT * FROM devices WHERE id = ?', did), b.address), credentials: { address: b.address, username: b.address, appPassword, ...connection() } };
  }

  /** Retire un appareil : son mot de passe d'application est supprimé chez Purelymail (l'appareil perd l'accès immédiatement). */
  async function removeDevice(userId, deviceId) {
    const d = db.get('SELECT * FROM devices WHERE id = ? AND user_id = ?', String(deviceId), userId);
    if (!d) throw new HttpError(404, 'Appareil introuvable.', 'not_found');
    const b = db.get('SELECT * FROM mailboxes WHERE id = ?', d.mailbox_id);
    if (pm.enabled && b) await pm.deleteAppPassword({ local: providerLocal(b), domain: b.domain, appPassword: vault.decrypt(d.secret_enc) });
    db.run('DELETE FROM devices WHERE id = ?', d.id);
    db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'smartphone', `Appareil « ${d.name} » retiré`, now());
    return { ok: true };
  }

  return { listBoxes, listAliases, listDevices, addDevice, removeDevice, connection, createBox, removeBox, addAlias, removeAlias, suspendMailboxes, reactivateMailboxes, reconcileRules, providerEnabled: pm.enabled };
}

module.exports = { createMail, createPurelymail };
