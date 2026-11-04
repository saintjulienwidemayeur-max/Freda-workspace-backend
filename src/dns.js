/**
 * DNS et connexion de domaines.
 *  - La zone (dns_records) est la source de vérité de l'interface.
 *  - Domaines enregistrés chez nous (NameSilo, serveurs par défaut) : chaque modification est répercutée via l'API DNS NameSilo AVANT d'être enregistrée.
 *  - Domaines externes : « records » (le client ajoute les enregistrements chez son fournisseur, nous vérifions en DNS réel)
 *    ou « nameservers » (nécessite un DNS autoritaire Freda sur NAMESERVERS : non fourni par ce backend).
 */
const crypto = require('crypto');
const dnsLib = require('dns');
const { HttpError } = require('./errors');

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
const id = () => 'dns_' + crypto.randomBytes(8).toString('hex');

/** Enregistrements e-mail Freda Mail (identiques à FW_CONFIG.MAIL_DNS_TEMPLATE du frontend). */
/** Modèle d'enregistrements e-mail. brand = domaine de votre zone qui relaie vers Purelymail (voir README) ; vide = Purelymail direct. Le MX reste chez Purelymail (un MX ne peut pas être un CNAME). */
function mailTemplate(brand = '') {
  const root = brand || 'purelymail.com';
  return [
    { type: 'MX', name: '@', value: 'mailserver.purelymail.com', priority: 50, role: 'MX' },
    { type: 'TXT', name: '@', value: `v=spf1 include:_spf.${root} ~all`, role: 'SPF' },
    { type: 'CNAME', name: 'purelymail1._domainkey', value: `key1.dkimroot.${root}`, role: 'DKIM' },
    { type: 'CNAME', name: 'purelymail2._domainkey', value: `key2.dkimroot.${root}`, role: 'DKIM' },
    { type: 'CNAME', name: 'purelymail3._domainkey', value: `key3.dkimroot.${root}`, role: 'DKIM' },
    { type: 'CNAME', name: '_dmarc', value: `dmarcroot.${root}`, role: 'DMARC' },
  ];
}
const MAIL_TEMPLATE = mailTemplate();

const HOST = /^(@|\*|[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$/i;
const FQDN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

function validateRecord(r) {
  const type = String(r.type || '').toUpperCase();
  if (!TYPES.includes(type)) throw new HttpError(400, 'Type d’enregistrement non pris en charge.', 'invalid_record');
  const name = String(r.name || '@').trim().toLowerCase();
  if (name.length > 120 || !HOST.test(name)) throw new HttpError(400, 'Nom d’hôte invalide.', 'invalid_record');
  const value = String(r.value || '').trim();
  if (!value || value.length > 500 || /[\r\n]/.test(value)) throw new HttpError(400, 'Valeur invalide.', 'invalid_record');
  if (type === 'A' && !IPV4.test(value)) throw new HttpError(400, 'Adresse IPv4 invalide.', 'invalid_record');
  if (type === 'AAAA' && !(IPV6.test(value) && value.includes(':'))) throw new HttpError(400, 'Adresse IPv6 invalide.', 'invalid_record');
  if ((type === 'CNAME' || type === 'MX') && !FQDN.test(value.replace(/\.$/, '').toLowerCase())) throw new HttpError(400, 'La cible doit être un nom de domaine.', 'invalid_record');
  if (type === 'CNAME' && name === '@') throw new HttpError(400, 'Un CNAME ne peut pas être placé à la racine du domaine.', 'invalid_record');
  const ttl = Number(r.ttl ?? 3600);
  if (!Number.isInteger(ttl) || ttl < 300 || ttl > 86400) throw new HttpError(400, 'TTL entre 300 et 86400 secondes.', 'invalid_record');
  let priority = null;
  if (type === 'MX') { priority = Number(r.priority ?? 10); if (!Number.isInteger(priority) || priority < 0 || priority > 65535) throw new HttpError(400, 'Priorité MX invalide.', 'invalid_record'); }
  return { type, name, value: type === 'TXT' ? value : value.replace(/\.$/, '').toLowerCase(), ttl, priority };
}

function defaultResolve(ip, domain, rrtype) {
  const r = new dnsLib.promises.Resolver({ timeout: 4000, tries: 1 });
  r.setServers([ip]);
  return rrtype === 'NS' ? r.resolveNs(domain) : rrtype === 'MX' ? r.resolveMx(domain) : rrtype === 'TXT' ? r.resolveTxt(domain) : r.resolveCname(domain);
}

function createDns({ cfg, db, registrar, log, resolve = defaultResolve }) {
  const brand = (cfg.mailDns && cfg.mailDns.brandDomain) || '';
  const BRANDED = brand ? mailTemplate(brand) : null;   // enregistrements « marque blanche » (relais dans VOTRE zone)
  const DIRECT = mailTemplate();                         // enregistrements Purelymail directs : toujours acceptés à la vérification (clients existants)

  /** Vérifie dans le DNS public que VOS relais existent (key1-3.dkimroot, dmarcroot en CNAME, _spf en TXT). Rien à publier chez les clients tant que ce n'est pas vrai. */
  async function brandStatus() {
    if (!brand) return { enabled: false, ready: false, brand: '', checks: [] };
    const ip = cfg.dns.resolvers[0];
    const norm = (v) => String(v).toLowerCase().replace(/\.$/, '');
    const checks = [];
    for (const n of [1, 2, 3]) {
      const name = `key${n}.dkimroot.${brand}`, want = `key${n}.dkimroot.purelymail.com`;
      const got = await resolve(ip, name, 'CNAME').catch(() => []);
      checks.push({ name, type: 'CNAME', want, ok: got.some((g) => norm(g) === want) });
    }
    { const name = `dmarcroot.${brand}`, want = 'dmarcroot.purelymail.com'; const got = await resolve(ip, name, 'CNAME').catch(() => []); checks.push({ name, type: 'CNAME', want, ok: got.some((g) => norm(g) === want) }); }
    { const name = `_spf.${brand}`, want = 'v=spf1 include:_spf.purelymail.com ~all'; const got = (await resolve(ip, name, 'TXT').catch(() => [])).map((a) => a.join('')); checks.push({ name, type: 'TXT', want, ok: got.some((t) => t.startsWith('v=spf1') && t.includes('_spf.purelymail.com')) }); }
    return { enabled: true, ready: checks.every((c) => c.ok), brand, checks };
  }
  let brandCache = { at: 0, ok: false };
  async function currentTemplate() {
    if (!brand) return DIRECT;
    const ttl = brandCache.ok ? 10 * 60_000 : 60_000;
    if (Date.now() - brandCache.at >= ttl) {
      const s = await brandStatus().catch(() => ({ ready: false, checks: [] }));
      brandCache = { at: Date.now(), ok: s.ready };
      if (!s.ready) log('warn', 'brand_dns_not_ready', { brand, missing: s.checks.filter((c) => !c.ok).map((c) => c.name) });   // repli : Purelymail direct, rien ne casse
    }
    return brandCache.ok ? BRANDED : DIRECT;
  }
  const spfOk = (t) => t.startsWith('v=spf1') && (t.includes('purelymail') || (brand && t.includes('_spf.' + brand)));
  const rec = (r) => ({ id: r.id, type: r.type, name: r.name, value: r.value, ttl: r.ttl, priority: r.priority ?? undefined, managed: !!r.managed, role: r.role || undefined });

  async function ownDomain(userId, name) {
    const d = await db.get('SELECT * FROM domains WHERE user_id = ? AND name = ?', userId, String(name || '').toLowerCase());
    if (!d) throw new HttpError(404, 'Domaine introuvable.', 'not_found');
    return d;
  }
  const usesRegistrarDns = (d) => !d.external && d.dns_mode === 'registrar';
  const list = async (userId, name) => (await db.all('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY CASE type WHEN \'A\' THEN 1 WHEN \'AAAA\' THEN 2 WHEN \'CNAME\' THEN 3 WHEN \'MX\' THEN 4 ELSE 5 END, name', (await ownDomain(userId, name)).id)).map(rec);

  async function save(userId, name, input) {
    const d = await ownDomain(userId, name);
    const v = validateRecord(input);
    const count = (await db.get('SELECT COUNT(*) AS n FROM dns_records WHERE domain_id = ?', d.id)).n;
    let existing = null;
    if (input.id) {
      existing = await db.get('SELECT * FROM dns_records WHERE id = ? AND domain_id = ?', String(input.id), d.id);
      if (!existing) throw new HttpError(404, 'Enregistrement introuvable.', 'not_found');
      if (existing.managed && (existing.type !== v.type || existing.name !== v.name)) throw new HttpError(400, 'Les enregistrements email gérés par Freda ne peuvent pas changer de type ou de nom.', 'managed_record');
    } else if (count >= 100) throw new HttpError(400, 'Limite de 100 enregistrements atteinte.', 'limit');
    if (!existing && (await db.get('SELECT 1 FROM dns_records WHERE domain_id = ? AND type = ? AND name = ? AND value = ?', d.id, v.type, v.name, v.value))) throw new HttpError(409, 'Cet enregistrement existe déjà.', 'duplicate');
    let providerId = existing ? existing.provider_id : '';
    if (usesRegistrarDns(d)) {
      try {
        const base = { domain: d.name, type: v.type, host: v.name, value: v.value, ttl: v.ttl, distance: v.priority };
        providerId = existing ? (await registrar.dnsUpdate({ ...base, id: existing.provider_id })).id : (await registrar.dnsAdd(base)).id;
      } catch (e) { log('error', 'dns_provider_failed', { code: e.code }); throw new HttpError(502, 'Le serveur DNS n’a pas accepté la modification. Réessayez.', 'dns_provider_error'); }
    }
    const rid = existing ? existing.id : id();
    if (existing) await db.run('UPDATE dns_records SET type=?, name=?, value=?, ttl=?, priority=?, provider_id=? WHERE id=?', v.type, v.name, v.value, v.ttl, v.priority, providerId, rid);
    else await db.run('INSERT INTO dns_records (id, domain_id, type, name, value, ttl, priority, managed, role, provider_id) VALUES (?,?,?,?,?,?,?,?,?,?)', rid, d.id, v.type, v.name, v.value, v.ttl, v.priority, input.managed ? 1 : 0, input.role || '', providerId);
    await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'server-cog', `Enregistrement ${v.type} « ${v.name} » ${existing ? 'mis à jour' : 'ajouté'} sur ${d.name}`, new Date().toISOString().slice(0, 16).replace('T', ' '));
    return rec(await db.get('SELECT * FROM dns_records WHERE id = ?', rid));
  }

  async function remove(userId, name, recordId) {
    const d = await ownDomain(userId, name);
    const r = await db.get('SELECT * FROM dns_records WHERE id = ? AND domain_id = ?', String(recordId), d.id);
    if (!r) throw new HttpError(404, 'Enregistrement introuvable.', 'not_found');
    if (r.managed) throw new HttpError(400, 'Cet enregistrement est nécessaire au fonctionnement de la messagerie. Utilisez « Réparer » pour le restaurer s’il est modifié.', 'managed_record');
    if (usesRegistrarDns(d) && r.provider_id) {
      try { await registrar.dnsDelete(d.name, r.provider_id); } catch (e) { log('error', 'dns_provider_failed', { code: e.code }); throw new HttpError(502, 'Le serveur DNS n’a pas accepté la suppression. Réessayez.', 'dns_provider_error'); }
    }
    await db.run('DELETE FROM dns_records WHERE id = ?', r.id);
    return { ok: true };
  }

  /** Ajoute les enregistrements e-mail manquants. Retourne le nombre ajouté. */
  async function autofix(userId, name, { quiet = false } = {}) {
    const d = await ownDomain(userId, name);
    const have = await db.all('SELECT * FROM dns_records WHERE domain_id = ?', d.id);
    let added = 0;
    for (const t of await currentTemplate()) {
      if (have.some((r) => r.type === t.type && r.name === t.name && r.value === t.value)) continue;
      // un ancien enregistrement e-mail incorrect (même type/nom, autre valeur) est remplacé plutôt que dupliqué (sauf TXT : plusieurs TXT sont légitimes)
      const stale = t.type !== 'TXT' && have.find((r) => r.type === t.type && r.name === t.name && r.managed);
      await save(userId, name, { ...t, id: stale && stale.id, managed: true, ttl: 3600 });
      added++;
    }
    if (added && !quiet) await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'wand-sparkles', `Configuration email réparée sur ${d.name} (${added} enregistrement${added > 1 ? 's' : ''})`, new Date().toISOString().slice(0, 16).replace('T', ' '));
    return { added };
  }

  /** Publie le TXT de propriété Purelymail (valeur fournie par getOwnershipCode). Zone du registrar : poussé chez NameSilo ; domaine externe : à ajouter par le client. */
  async function ensureOwnership(userId, name, value) {
    const d = await ownDomain(userId, name);
    if ((await db.get('SELECT 1 FROM dns_records WHERE domain_id = ? AND type = ? AND name = ? AND value = ?', d.id, 'TXT', '@', value))) return;
    await save(userId, name, { type: 'TXT', name: '@', value, ttl: 3600, managed: true, role: 'OWNERSHIP' });
  }

  /** Le TXT de propriété est-il visible dans le DNS public (premier résolveur) ? Sert à dire au client si sa vérification a une chance d'aboutir. */
  async function txtVisible(name, value) {
    try { return (await resolve(cfg.dns.resolvers[0], name, 'TXT')).some((a) => a.join('') === value); } catch (e) { return false; }
  }

  /** Santé de la zone (même logique que le frontend). */
  function health(records) {
    const has = (p) => records.some(p);
    const dkim = records.filter((r) => r.name.endsWith('._domainkey')).length;
    return {
      MX: has((r) => r.type === 'MX' && r.value.includes('purelymail')) ? 'ok' : 'missing',
      SPF: has((r) => r.type === 'TXT' && spfOk(r.value)) ? 'ok' : 'missing',
      DKIM: dkim >= 3 ? 'ok' : dkim > 0 ? 'partial' : 'missing',
      DMARC: has((r) => r.name === '_dmarc') ? 'ok' : 'missing',
    };
  }

  /** Propagation réelle : le MX de Freda Mail est-il visible depuis plusieurs résolveurs publics ? */
  async function propagation(userId, name) {
    const d = await ownDomain(userId, name);
    return Promise.all(cfg.dns.resolvers.map(async (ip) => {
      const t0 = Date.now();
      try { const mx = await resolve(ip, d.name, 'MX'); return { resolver: resolverName(ip), ip, ok: mx.some((m) => /purelymail/i.test(m.exchange)), ms: Date.now() - t0 }; }
      catch (e) { return { resolver: resolverName(ip), ip, ok: false, ms: Date.now() - t0 }; }
    }));
  }
  const resolverName = (ip) => ({ '8.8.8.8': 'Google', '1.1.1.1': 'Cloudflare', '9.9.9.9': 'Quad9', '208.67.222.222': 'OpenDNS' }[ip] || ip);

  /* ---------- Domaines existants (hébergés ailleurs) ---------- */
  async function connect(userId, rawDomain, mode = 'records') {
    const name = String(rawDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!FQDN.test(name)) throw new HttpError(400, 'Entrez un domaine complet, par exemple monentreprise.com.', 'invalid_domain');
    if (!['nameservers', 'records'].includes(mode)) throw new HttpError(400, 'Méthode inconnue.', 'invalid_mode');
    const mine = await db.get('SELECT * FROM domains WHERE user_id = ? AND name = ?', userId, name);
    if (mine && mine.status !== 'pending') throw new HttpError(409, 'Ce domaine est déjà dans votre espace.', 'duplicate');
    if ((await db.get("SELECT 1 FROM domains WHERE name = ? AND status <> 'pending'", name))) throw new HttpError(409, 'Ce domaine appartient déjà à un autre compte Freda.', 'domain_taken');
    let did;
    await db.tx(async () => {
      if (mine) { did = mine.id; await db.run('UPDATE domains SET dns_mode = ? WHERE id = ?', mode, did); }
      else {
        did = 'dom_' + crypto.randomBytes(8).toString('hex');
        const first = !(await db.get('SELECT 1 FROM domains WHERE user_id = ?', userId));
        await db.run('INSERT INTO domains (id, user_id, name, status, external, dns_mode, registered_at, auto_renew, locked, is_primary, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          did, userId, name, 'pending', 1, mode, new Date().toISOString().slice(0, 10), 0, 0, first ? 1 : 0, new Date().toISOString());
        await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'link-2', `Domaine existant ${name} ajouté`, new Date().toISOString().slice(0, 16).replace('T', ' '));
      }
      const have = await db.all('SELECT * FROM dns_records WHERE domain_id = ?', did);
      for (const t of await currentTemplate()) if (!have.some((r) => r.type === t.type && r.name === t.name && r.value === t.value))
        await db.run('INSERT INTO dns_records (id, domain_id, type, name, value, ttl, priority, managed, role) VALUES (?,?,?,?,?,?,?,?,?)', id(), did, t.type, t.name, t.value, 3600, t.priority ?? null, 1, t.role);
    });
    return { domain: name, mode, nameservers: cfg.namesilo.nameservers, records: await currentTemplate(), nameserversAvailable: cfg.namesilo.nameservers.length >= 2 };
  }

  /** Vérifie la connexion en DNS réel : serveurs de noms (mode nameservers) ou enregistrements e-mail (mode records). */
  async function verify(userId, name) {
    const d = await ownDomain(userId, name);
    if (!d.external) return { connected: true, missing: [] };
    if (d.status === 'active') return { connected: true, missing: [] };
    const ip = cfg.dns.resolvers[0];
    const missing = [];
    try {
      if (d.dns_mode === 'nameservers') {
        if (cfg.namesilo.nameservers.length < 2) throw new HttpError(409, 'Les serveurs de noms Freda ne sont pas encore disponibles. Choisissez « Garder mon DNS actuel ».', 'nameservers_unavailable');
        const ns = (await resolve(ip, d.name, 'NS')).map((x) => x.toLowerCase().replace(/\.$/, ''));
        for (const want of cfg.namesilo.nameservers) if (!ns.includes(want.toLowerCase())) missing.push('NS ' + want);
      } else {
        const mx = await resolve(ip, d.name, 'MX').catch(() => []);
        if (!mx.some((m) => /purelymail/i.test(m.exchange))) missing.push('MX');
        const txt = (await resolve(ip, d.name, 'TXT').catch(() => [])).map((a) => a.join(''));
        if (!txt.some(spfOk)) missing.push('SPF');
        // DKIM : sans les 3 CNAME, le courrier part mais atterrit en spam ; on ne déclare donc pas le domaine « connecté » avant.
        let dkimOk = true;
        for (let i = 0; i < DIRECT.length; i++) {
          const r = DIRECT[i];
          if (r.role !== 'DKIM') continue;
          const ok = [r.value, BRANDED && BRANDED[i].value].filter(Boolean).map((v) => v.toLowerCase());   // cible Purelymail directe OU cible de marque blanche
          const got = await resolve(ip, r.name + '.' + d.name, 'CNAME').catch(() => []);
          if (!got.some((g) => ok.includes(String(g).toLowerCase().replace(/\.$/, '')))) dkimOk = false;
        }
        if (!dkimOk) missing.push('DKIM');
      }
    } catch (e) { if (e instanceof HttpError) throw e; missing.push('DNS'); }
    if (missing.length) return { connected: false, missing };
    if ((await db.get("SELECT 1 FROM domains WHERE name = ? AND status <> 'pending' AND id <> ?", d.name, d.id))) throw new HttpError(409, 'Ce domaine a déjà été vérifié par un autre compte Freda.', 'domain_taken');
    await db.run("UPDATE domains SET status = 'active', connected_at = ? WHERE id = ?", new Date().toISOString().slice(0, 10), d.id);
    await db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'badge-check', `Domaine ${d.name} connecté`, new Date().toISOString().slice(0, 16).replace('T', ' '));
    return { connected: true, missing: [] };
  }

  return { list, save, remove, autofix, ensureOwnership, txtVisible, health, propagation, connect, verify, validateRecord, mailTemplate: currentTemplate, brandStatus, ownDomain };
}

module.exports = { createDns, MAIL_TEMPLATE, mailTemplate, validateRecord };
