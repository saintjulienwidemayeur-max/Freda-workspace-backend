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
const { imapLogin } = require('./imap');
const { issueMailboxToken } = require('./auth');

const LOCAL = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
/** Mots de passe trop courants refusés (le reste est laissé libre : une phrase de passe simple vaut mieux qu'un code compliqué qu'on note ou qu'on se trompe à saisir). */
const COMMON_PASSWORDS = new Set(['12345678', '123456789', '1234567890', '87654321', 'password', 'password1', 'motdepasse', 'motdepasse1', 'azertyui', 'azerty123', 'azertyuiop', 'qwerty123', 'qwertyuiop', '11111111', '00000000', 'iloveyou', 'freda123', 'fredamail', 'bienvenue']);
/** Mot de passe de la boîte choisi par le client : 8 à 128 caractères, pas un mot de passe trop courant, ni le nom de la boîte. */
function validatePassword(pw, local) {
  // Règles affichées au client par le frontend (assets/js/api.js, FW.passwordRules). Purelymail peut en plus refuser un mot de passe jugé trop faible (invalidPassword).
  const p = String(pw ?? '');
  if (p.length < 8 || p.length > 128 || /[\0\r\n]/.test(p)) throw new HttpError(400, 'Le mot de passe de la boîte doit faire entre 8 et 128 caractères.', 'weak_password');
  const lp = p.toLowerCase();
  if (COMMON_PASSWORDS.has(lp) || /^(.)\1+$/.test(p)) throw new HttpError(400, 'Ce mot de passe est trop courant. Ajoutez quelques mots ou chiffres, par exemple trois mots séparés par des tirets : cheval-bleu-maison.', 'weak_password');
  if (local && String(local).length >= 3 && lp === String(local).toLowerCase()) throw new HttpError(400, 'Le mot de passe ne doit pas être le nom de la boîte.', 'weak_password');
  return p;
}
const id = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

function createPurelymail(cfg, log) {
  const enabled = !!cfg.purelymail.apiKey;
  async function call(endpoint, body) {
    const res = await fetch(`${cfg.purelymail.baseUrl.replace(/\/$/, '')}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Purelymail-Api-Token': cfg.purelymail.apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    let data = {};
    try { data = await res.json(); } catch (e) { /* corps non JSON */ }
    if (!res.ok || data.type === 'error') {
      log('error', 'purelymail_failed', { endpoint, status: res.status, code: data.code });
      if (data.code === 'invalidPassword') throw new HttpError(400, 'Le serveur de messagerie a refusé ce mot de passe. Choisissez-en un plus long : par exemple quatre mots simples séparés par des tirets et suivis de deux chiffres (cheval-bleu-maison-soleil42).', 'weak_password');
      throw new HttpError(502, 'Le serveur de messagerie n’a pas accepté la demande. Réessayez.', 'mail_provider_error'); }
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
      const before = new Set(((await call('listRoutingRules', {})).rules || []).map((r) => r.id));
      await call('createRoutingRule', { domainName: domain, prefix: false, matchUser: local, targetAddresses: targets, catchall: false });
      const rules = (await call('listRoutingRules', {})).rules || [];
      const fresh = rules.filter((r) => !before.has(r.id) && String(r.domainName).toLowerCase() === domain && r.matchUser === local && !r.prefix && !r.catchall);
      const hit = fresh.sort((a, b) => b.id - a.id)[0];   // la règle nouvelle (absente de la liste d'avant), pas celle d'une requête simultanée
      return { id: hit ? hit.id : '' };
    },
    deleteRoutingRule: (ref) => call('deleteRoutingRule', { routingRuleId: Number(ref) }),
  };
}

function createMail({ cfg, db, log, provider, dns, vault, mailer }) {
  const pm = provider || createPurelymail(cfg, log);
  const box = (r) => ({ id: r.id, address: r.address, name: r.name, usedGb: r.used_gb, created: r.created_at.slice(0, 10), lastLogin: r.last_login ? r.last_login.slice(0, 10) : null, role: r.role, status: r.provider_status });
  const alias = (r) => ({ id: r.id, from: r.from_addr, to: r.to_addr });

  const subscription = async (userId) => {
    const s = await db.get('SELECT * FROM subscriptions WHERE user_id = ?', userId);
    if (!s) return { user_id: userId, plan: 'free', status: 'active' };   // offre gratuite : 1 boîte sans paiement
    if (!['active', 'past_due'].includes(s.status)) throw new HttpError(402, 'Votre offre Freda Mail n’est plus active : réglez-la pour continuer.', 'no_subscription');
    return s;
  };
  const ownDomain = async (userId, domain) => {
    const d = await db.get("SELECT * FROM domains WHERE user_id = ? AND name = ? AND status IN ('active','pending')", userId, String(domain || '').toLowerCase());
    if (!d) throw new HttpError(404, 'Domaine introuvable dans votre espace.', 'not_found');
    return d;
  };

  /**
   * Garantit que le domaine existe chez Purelymail : publie le TXT de propriété (zone gérée par Freda Workspace) puis addDomain.
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
      // domaine hébergé ailleurs : c'est le CLIENT qui doit publier le TXT chez son hébergeur DNS ; sinon la propagation de notre propre zone suffit
      if (d.external) throw new HttpError(409, `Pour activer l’email sur ${d.name}, ajoutez d’abord l’enregistrement TXT de vérification chez l’hébergeur de votre DNS, puis réessayez (propagation : jusqu’à 15 minutes).`, 'domain_ownership_required', { domain: d.name, record: { type: 'TXT', name: '@', value: code } });
      throw new HttpError(409, `Le domaine ${d.name} est en cours de vérification (propagation DNS, jusqu’à 15 minutes). Réessayez dans quelques minutes.`, 'domain_pending_verification');
    }
  }

  /**
   * Étape « vérification du domaine pour l'email » : l'enregistrement TXT à publier + l'état (verified : accepté par Purelymail ; dns_ok : visible dans le DNS,
   * la prochaine création de boîte réussira ; pending : pas encore visible). Zone gérée par Freda Workspace : publié automatiquement ; domaine externe : à ajouter chez l'hébergeur.
   */
  async function ownership(userId, domain) {
    const d = await ownDomain(userId, domain);
    if (!pm.enabled) throw new HttpError(503, 'La messagerie est en cours d’activation. Réessayez dans quelques minutes.', 'mailbox_not_ready');
    const code = await pm.ownershipCode();
    if (!code) throw new HttpError(502, 'Le serveur de messagerie n’a pas fourni le code de vérification. Réessayez.', 'mail_provider_error');
    if (dns) await dns.ensureOwnership(userId, d.name, code);
    let status = 'pending';
    if ((await pm.listDomains()).includes(d.name)) status = 'verified';
    else if (dns && await dns.txtVisible(d.name, code)) status = 'dns_ok';
    return { domain: d.name, external: !!d.external, managedByFreda: !d.external && d.dns_mode === 'registrar', record: { type: 'TXT', name: '@', value: code }, status };
  }

  const listBoxes = async (userId) => (await db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status <> 'creating' ORDER BY created_at", userId)).map(box);
  const listAliases = async (userId) => (await db.all('SELECT * FROM aliases WHERE user_id = ? ORDER BY from_addr', userId)).map(alias);

  /** Crée une boîte. Le mot de passe initial n'est renvoyé QU'ICI (jamais stocké). */
  async function createBox(userId, { local, domain, name, password: chosen }) {
    const sub = await subscription(userId);
    const lp = String(local || '').trim().toLowerCase();
    if (!LOCAL.test(lp)) throw new HttpError(400, 'Nom de boîte invalide (lettres, chiffres, point, tiret).', 'invalid_local');
    const d = await ownDomain(userId, domain);
    const plan = cfg.plans[sub.plan];
    const address = `${lp}@${d.name}`;
    const chosenPw = chosen === undefined || chosen === null || chosen === '' ? null : validatePassword(chosen, lp);
    const password = chosenPw || crypto.randomBytes(12).toString('base64url');
    // 1. Réservation en base (verrou sur l'abonnement du client) : limite d'offre et doublons vérifiés sans course entre deux requêtes simultanées.
    const bid = id('mbx');
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();   // une réservation « creating » abandonnée (crash) cesse de compter au bout de 5 min
    await db.tx(async () => {
      await db.get('SELECT id FROM users WHERE id = ? FOR UPDATE', userId);   // verrou par client (les comptes gratuits n'ont pas de ligne d'abonnement)
      await db.run("DELETE FROM mailboxes WHERE provider_status = 'creating' AND created_at < ?", stale);
      const count = (await db.get('SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?', userId)).n;
      if (count >= plan.mailboxes) throw new HttpError(403, `Votre offre ${plan.name} est limitée à ${plan.mailboxes} boîte${plan.mailboxes > 1 ? 's' : ''}. Passez à une offre supérieure.`, 'plan_limit');
      if ((await db.get('SELECT 1 FROM mailboxes WHERE address = ?', address)) || (await db.get('SELECT 1 FROM aliases WHERE from_addr = ?', address))) throw new HttpError(409, 'Cette adresse existe déjà.', 'duplicate');
      await db.run('INSERT INTO mailboxes (id, user_id, domain, local_part, address, name, role, provider_status, created_at) VALUES (?,?,?,?,?,?,?,?,?)', bid, userId, d.name, lp, address, String(name || lp).trim().slice(0, 80), count === 0 ? 'Propriétaire' : 'Utilisateur', pm.enabled ? 'creating' : 'pending_provider', new Date().toISOString());
    });
    // 2. Création chez Purelymail ; en cas d'échec la réservation est supprimée (aucune boîte fantôme, la place est rendue).
    let status = 'pending_provider';
    if (pm.enabled) {
      try { await ensureProviderDomain(userId, d); await pm.createUser({ local: lp, domain: d.name, password }); }
      catch (e) { await db.run("DELETE FROM mailboxes WHERE id = ? AND provider_status = 'creating'", bid); throw e; }
      status = 'active';
      await db.run("UPDATE mailboxes SET provider_status = 'active' WHERE id = ?", bid);
    }
    await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'mail-plus', `Boîte ${address} créée`, now());
    return { mailbox: box(await db.get('SELECT * FROM mailboxes WHERE id = ?', bid)), initialPassword: status === 'active' && !chosenPw ? password : null, providerReady: status === 'active' };
  }

  async function removeBox(userId, boxId) {
    const b = await db.get('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?', String(boxId), userId);
    if (!b) throw new HttpError(404, 'Boîte introuvable.', 'not_found');
    if (b.role === 'Propriétaire' && (await db.get('SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?', userId)).n > 1) throw new HttpError(400, 'Supprimez d’abord les autres boîtes ou transférez la propriété.', 'owner_box');
    if (pm.enabled && b.provider_status !== 'pending_provider') {
      if (b.provider_user) await dropSuspendRules(b, b.provider_user);
      await pm.deleteUser({ local: providerLocal(b), domain: b.domain });
    }
    await db.tx(async () => {
      await db.run('DELETE FROM push_devices WHERE mailbox_id = ?', b.id); await db.run('DELETE FROM push_credentials WHERE mailbox_id = ?', b.id);
      for (const a of await db.all('SELECT * FROM aliases WHERE user_id = ? AND to_addr = ?', userId, b.address)) await db.run('DELETE FROM aliases WHERE id = ?', a.id);
      await db.run('DELETE FROM mailboxes WHERE id = ?', b.id);
    });
    return { ok: true };
  }

  async function addAlias(userId, { from, to }) {
    await subscription(userId);
    const f = String(from || '').trim().toLowerCase(), t = String(to || '').trim().toLowerCase();
    const m = /^([^@\s]+)@([^@\s]+)$/.exec(f);
    if (!m || !LOCAL.test(m[1])) throw new HttpError(400, 'Adresse d’alias invalide.', 'invalid_alias');
    await ownDomain(userId, m[2]);
    const target = await db.get('SELECT * FROM mailboxes WHERE user_id = ? AND address = ?', userId, t);
    if (!target) throw new HttpError(400, 'La destination doit être l’une de vos boîtes.', 'invalid_target');
    if ((await db.get('SELECT 1 FROM mailboxes WHERE address = ?', f)) || (await db.get('SELECT 1 FROM aliases WHERE from_addr = ?', f))) throw new HttpError(409, 'Cette adresse existe déjà.', 'duplicate');
    if (pm.enabled && target.provider_status !== 'active') throw new HttpError(409, 'La boîte de destination n’est pas active (en attente ou suspendue) : créez l’alias quand elle fonctionne.', 'target_inactive');
    let ref = '';
    if (pm.enabled) ref = String((await pm.createRoutingRule({ domain: m[2], local: m[1], targets: [t] })).id || '');
    const aid = id('als');
    try { await db.run('INSERT INTO aliases (id, user_id, from_addr, to_addr, provider_ref) VALUES (?,?,?,?,?)', aid, userId, f, t, ref); }
    catch (e) { if (ref) await pm.deleteRoutingRule(ref).catch(() => log('warn', 'orphan_routing_rule', { alias: f })); throw e; }
    return alias(await db.get('SELECT * FROM aliases WHERE id = ?', aid));
  }
  async function removeAlias(userId, aliasId) {
    const a = await db.get('SELECT * FROM aliases WHERE id = ? AND user_id = ?', String(aliasId), userId);
    if (!a) throw new HttpError(404, 'Alias introuvable.', 'not_found');
    if (pm.enabled && a.provider_ref) await pm.deleteRoutingRule(a.provider_ref);
    await db.run('DELETE FROM aliases WHERE id = ?', a.id);
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
      await db.run("UPDATE mailboxes SET rule_state = 'set' WHERE id = ?", b.id); return true;
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
   * Suspension (offre impayée ou résiliée). Mode « rename » (défaut) : la boîte est renommée (susp-xxxx) ; le mot de passe CHOISI PAR LE CLIENT n'est pas touché.
   * L'identifiant de connexion change donc : mot de passe principal, mots de passe d'application et sessions webmail de l'ancienne adresse cessent tous de fonctionner,
   * le client ne connaît pas le nouveau nom, et à la réactivation il retrouve exactement ses identifiants. Le courrier entrant est redirigé vers la boîte renommée : messages conservés, rien n'est supprimé.
   * Mode « password » (MAIL_SUSPEND_MODE=password) : seul le mot de passe change, remplacé par un secret aléatoire (ne révoque PAS les mots de passe d'application). Les échecs sont retentés au passage suivant.
   */
  async function suspendMailboxes(userId) {
    let suspended = 0, failed = 0;
    for (const b of await db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'active'", userId)) {
      try {
        const alias = renameMode ? 'susp-' + crypto.randomBytes(5).toString('hex') : '';
        if (pm.enabled) await pm.modifyUser({ local: b.local_part, domain: b.domain, newLocal: alias || undefined, password: alias ? undefined : secret() });
        await db.run("UPDATE mailboxes SET provider_status = 'suspended', provider_user = ?, rule_state = ?, tokens_valid_after = ? WHERE id = ?", alias, alias ? 'pending' : '', Date.now(), b.id);
        suspended++;
      } catch (e) { failed++; log('warn', 'mailbox_suspend_failed', { mailbox: b.address }); }
    }
    for (const b of await db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'suspended' AND rule_state = 'pending'", userId)) if (!(await ensureSuspendRule(b))) failed++;
    return { suspended, failed };
  }

  /** Réactivation après paiement : mode rename -> l'ancien nom est rétabli, le client retrouve SES identifiants (aucun mot de passe à renvoyer). Mode password -> nouveau mot de passe, renvoyé UNE fois. */
  async function reactivateMailboxes(userId) {
    const mailboxes = []; let failed = 0;
    for (const b of await db.all("SELECT * FROM mailboxes WHERE user_id = ? AND provider_status = 'suspended'", userId)) {
      const password = b.provider_user ? undefined : secret();
      try {
        if (pm.enabled) await pm.modifyUser({ local: providerLocal(b), domain: b.domain, newLocal: b.provider_user ? b.local_part : undefined, password });
        await db.run("UPDATE mailboxes SET provider_status = 'active', provider_user = '', rule_state = ? WHERE id = ?", b.provider_user ? 'cleanup' : '', b.id);
        mailboxes.push({ address: b.address, password });
      } catch (e) { failed++; log('warn', 'mailbox_reactivate_failed', { mailbox: b.address }); }
    }
    await reconcileRules(userId);
    return { mailboxes, failed };
  }

  /** Règles de routage de suspension : posées pour les boîtes suspendues, retirées pour les boîtes réactivées (retentées tant que nécessaire). */
  async function reconcileRules(userId) {
    let failed = 0;
    for (const b of await db.all("SELECT * FROM mailboxes WHERE user_id = ? AND rule_state IN ('pending','cleanup')", userId)) {
      if (b.rule_state === 'pending' && b.provider_status === 'suspended') { if (!(await ensureSuspendRule(b))) failed++; }
      else if (b.rule_state === 'cleanup' && b.provider_status === 'active') { if (await dropSuspendRules(b)) await db.run("UPDATE mailboxes SET rule_state = '' WHERE id = ?", b.id); else failed++; }
    }
    return { failed };
  }

  /* ---------- Application mobile ---------- */
  /** Le titulaire du compte change (ou réinitialise) le mot de passe d'une de ses boîtes. */
  async function changePassword(userId, boxId, password) {
    const b = await db.get('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?', String(boxId), userId);
    if (!b) throw new HttpError(404, 'Boîte introuvable.', 'not_found');
    if (b.provider_status === 'suspended') throw new HttpError(409, 'Cette boîte est suspendue : réglez votre offre pour la réactiver.', 'mailbox_suspended');
    if (b.provider_status !== 'active' || !pm.enabled) throw new HttpError(503, 'La messagerie est en cours d’activation. Réessayez dans quelques minutes.', 'mailbox_not_ready');
    const pw = validatePassword(password, b.local_part);
    await pm.modifyUser({ local: b.local_part, domain: b.domain, password: pw });
    await db.run('UPDATE mailboxes SET tokens_valid_after = ? WHERE id = ?', Date.now(), b.id);   // les sessions de l'application sont déconnectées
    await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'key-round', `Mot de passe de ${b.address} modifié`, now());
    return { ok: true };
  }

  /**
   * Connexion de l'application mobile : « adresse pro + mot de passe de la boîte » (ceux choisis par le client sur la plateforme).
   * Le mot de passe est vérifié chez Purelymail par IMAP ; on ne tente que les adresses connues de la plateforme (jamais un serveur IMAP ouvert à tous).
   * Réponse : état de la boîte + réglages IMAP/SMTP ; l'application range ensuite l'identifiant dans le Keychain / Keystore et parle directement IMAP/SMTP.
   * Échecs : 5 mots de passe faux par adresse et par 15 minutes, puis blocage 15 minutes (429).
   */
  const failures = new Map();
  const LOCK_MS = 15 * 60 * 1000, MAX_FAILS = 5;
  async function appLogin({ email, address: addr, username, password }) {
    const address = String(email || addr || username || '').trim().toLowerCase();
    const bad = () => new HttpError(401, 'Adresse ou mot de passe incorrect.', 'invalid_credentials');
    if (!/^[^@\s]+@[^@\s]+$/.test(address) || typeof password !== 'string' || !password || password.length > 256) throw bad();
    const f = failures.get(address);
    if (f && f.n >= MAX_FAILS && Date.now() - f.t < LOCK_MS) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.', 'rate_limited');
    const b = await db.get('SELECT * FROM mailboxes WHERE address = ?', address);
    if (!b) { log('info', 'mail_login_failed', { address, reason: 'unknown_address' }); await new Promise((r) => setTimeout(r, 150)); throw bad(); }
    const sub = await db.get('SELECT status FROM subscriptions WHERE user_id = ?', b.user_id);
    if (b.provider_status === 'suspended' || (sub && ['suspended', 'cancelled'].includes(sub.status))) throw new HttpError(402, 'Votre abonnement email n’est plus actif. Réglez-le depuis votre espace Freda Workspace pour retrouver votre messagerie.', 'subscription_inactive');
    if (b.provider_status !== 'active' || !pm.enabled) throw new HttpError(503, 'Votre messagerie est en cours d’activation. Réessayez dans quelques minutes.', 'mailbox_not_ready');
    const t0 = Date.now();
    const reserved = f && t0 - f.t < LOCK_MS ? f.n + 1 : 1;
    failures.set(address, { n: reserved, t: t0 });   // tentative comptée AVANT la vérification (annulée en cas de succès)
    let result;
    try { result = await imapLogin({ host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure, user: address, pass: password }); }
    catch (e) { if (reserved > 1) failures.set(address, { n: reserved - 1, t: t0 }); else failures.delete(address); log('warn', 'imap_check_failed', { message: e.message }); throw new HttpError(503, 'Le serveur de messagerie ne répond pas. Réessayez.', 'mail_provider_error'); }
    if (result !== 'ok') {
      log('info', 'mail_login_failed', { address, reason: 'imap_denied', attempts: reserved, passwordLength: password.length });   // jamais le mot de passe lui-même
      if (failures.size > 5000) for (const [k, v] of failures) if (Date.now() - v.t > LOCK_MS) failures.delete(k);
      throw bad();
    }
    failures.delete(address);
    log('info', 'mail_login_ok', { address });
    await db.run('UPDATE mailboxes SET last_login = ? WHERE id = ?', new Date().toISOString(), b.id);
    return { mailbox: { address: b.address, name: b.name, status: 'active' }, token: issueMailboxToken(cfg, b), tokenExpiresInDays: cfg.push.sessionDays, ...connection() };
  }

  /** Réglages IMAP / SMTP publiés par Purelymail (https://purelymail.com/docs/setup/technical). */
  const connection = () => ({
    imap: { host: 'imap.purelymail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.purelymail.com', port: 465, security: 'ssl', alternative: { port: 587, security: 'starttls' } },
  });

  return { listBoxes, listAliases, connection, changePassword, appLogin, validatePassword, ownership, provider: pm, createBox, removeBox, addAlias, removeAlias, suspendMailboxes, reactivateMailboxes, reconcileRules, providerEnabled: pm.enabled };
}

module.exports = { createMail, createPurelymail };
