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
const MAIL_TEMPLATE = [
  { type: 'MX', name: '@', value: 'mailserver.purelymail.com', priority: 50, role: 'MX' },
  { type: 'TXT', name: '@', value: 'v=spf1 include:_spf.purelymail.com ~all', role: 'SPF' },
  { type: 'CNAME', name: 'purelymail1._domainkey', value: 'key1.dkimroot.purelymail.com', role: 'DKIM' },
  { type: 'CNAME', name: 'purelymail2._domainkey', value: 'key2.dkimroot.purelymail.com', role: 'DKIM' },
  { type: 'CNAME', name: 'purelymail3._domainkey', value: 'key3.dkimroot.purelymail.com', role: 'DKIM' },
  { type: 'CNAME', name: '_dmarc', value: 'dmarcroot.purelymail.com', role: 'DMARC' },
];

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
  const rec = (r) => ({ id: r.id, type: r.type, name: r.name, value: r.value, ttl: r.ttl, priority: r.priority ?? undefined, managed: !!r.managed, role: r.role || undefined });

  function ownDomain(userId, name) {
    const d = db.get('SELECT * FROM domains WHERE user_id = ? AND name = ?', userId, String(name || '').toLowerCase());
    if (!d) throw new HttpError(404, 'Domaine introuvable.', 'not_found');
    return d;
  }
  const usesRegistrarDns = (d) => !d.external && d.dns_mode === 'registrar';
  const list = (userId, name) => db.all('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY CASE type WHEN \'A\' THEN 1 WHEN \'AAAA\' THEN 2 WHEN \'CNAME\' THEN 3 WHEN \'MX\' THEN 4 ELSE 5 END, name', ownDomain(userId, name).id).map(rec);

  async function save(userId, name, input) {
    const d = ownDomain(userId, name);
    const v = validateRecord(input);
    const count = db.get('SELECT COUNT(*) AS n FROM dns_records WHERE domain_id = ?', d.id).n;
    let existing = null;
    if (input.id) {
      existing = db.get('SELECT * FROM dns_records WHERE id = ? AND domain_id = ?', String(input.id), d.id);
      if (!existing) throw new HttpError(404, 'Enregistrement introuvable.', 'not_found');
      if (existing.managed && (existing.type !== v.type || existing.name !== v.name)) throw new HttpError(400, 'Les enregistrements email gérés par Freda ne peuvent pas changer de type ou de nom.', 'managed_record');
    } else if (count >= 100) throw new HttpError(400, 'Limite de 100 enregistrements atteinte.', 'limit');
    if (!existing && db.get('SELECT 1 FROM dns_records WHERE domain_id = ? AND type = ? AND name = ? AND value = ?', d.id, v.type, v.name, v.value)) throw new HttpError(409, 'Cet enregistrement existe déjà.', 'duplicate');
    let providerId = existing ? existing.provider_id : '';
    if (usesRegistrarDns(d)) {
      try {
        const base = { domain: d.name, type: v.type, host: v.name, value: v.value, ttl: v.ttl, distance: v.priority };
        providerId = existing ? (await registrar.dnsUpdate({ ...base, id: existing.provider_id })).id : (await registrar.dnsAdd(base)).id;
      } catch (e) { log('error', 'dns_provider_failed', { code: e.code }); throw new HttpError(502, 'Le serveur DNS n’a pas accepté la modification. Réessayez.', 'dns_provider_error'); }
    }
    const rid = existing ? existing.id : id();
    if (existing) db.run('UPDATE dns_records SET type=?, name=?, value=?, ttl=?, priority=?, provider_id=? WHERE id=?', v.type, v.name, v.value, v.ttl, v.priority, providerId, rid);
    else db.run('INSERT INTO dns_records (id, domain_id, type, name, value, ttl, priority, managed, role, provider_id) VALUES (?,?,?,?,?,?,?,?,?,?)', rid, d.id, v.type, v.name, v.value, v.ttl, v.priority, input.managed ? 1 : 0, input.role || '', providerId);
    db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'server-cog', `Enregistrement ${v.type} « ${v.name} » ${existing ? 'mis à jour' : 'ajouté'} sur ${d.name}`, new Date().toISOString().slice(0, 16).replace('T', ' '));
    return rec(db.get('SELECT * FROM dns_records WHERE id = ?', rid));
  }

  async function remove(userId, name, recordId) {
    const d = ownDomain(userId, name);
    const r = db.get('SELECT * FROM dns_records WHERE id = ? AND domain_id = ?', String(recordId), d.id);
    if (!r) throw new HttpError(404, 'Enregistrement introuvable.', 'not_found');
    if (r.managed) throw new HttpError(400, 'Cet enregistrement est nécessaire au fonctionnement de la messagerie. Utilisez « Réparer » pour le restaurer s’il est modifié.', 'managed_record');
    if (usesRegistrarDns(d) && r.provider_id) {
      try { await registrar.dnsDelete(d.name, r.provider_id); } catch (e) { log('error', 'dns_provider_failed', { code: e.code }); throw new HttpError(502, 'Le serveur DNS n’a pas accepté la suppression. Réessayez.', 'dns_provider_error'); }
    }
    db.run('DELETE FROM dns_records WHERE id = ?', r.id);
    return { ok: true };
  }

  /** Ajoute les enregistrements e-mail manquants. Retourne le nombre ajouté. */
  async function autofix(userId, name, { quiet = false } = {}) {
    const d = ownDomain(userId, name);
    const have = db.all('SELECT * FROM dns_records WHERE domain_id = ?', d.id);
    let added = 0;
    for (const t of MAIL_TEMPLATE) {
      if (have.some((r) => r.type === t.type && r.name === t.name && r.value === t.value)) continue;
      // un ancien enregistrement e-mail incorrect (même type/nom, autre valeur) est remplacé plutôt que dupliqué (sauf TXT : plusieurs TXT sont légitimes)
      const stale = t.type !== 'TXT' && have.find((r) => r.type === t.type && r.name === t.name && r.managed);
      await save(userId, name, { ...t, id: stale && stale.id, managed: true, ttl: 3600 });
      added++;
    }
    if (added && !quiet) db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'wand-sparkles', `Configuration email réparée sur ${d.name} (${added} enregistrement${added > 1 ? 's' : ''})`, new Date().toISOString().slice(0, 16).replace('T', ' '));
    return { added };
  }

  /** Santé de la zone (même logique que le frontend). */
  function health(records) {
    const has = (p) => records.some(p);
    const dkim = records.filter((r) => r.name.endsWith('._domainkey')).length;
    return {
      MX: has((r) => r.type === 'MX' && r.value.includes('purelymail')) ? 'ok' : 'missing',
      SPF: has((r) => r.type === 'TXT' && r.value.startsWith('v=spf1') && r.value.includes('purelymail')) ? 'ok' : 'missing',
      DKIM: dkim >= 3 ? 'ok' : dkim > 0 ? 'partial' : 'missing',
      DMARC: has((r) => r.name === '_dmarc') ? 'ok' : 'missing',
    };
  }

  /** Propagation réelle : le MX de Freda Mail est-il visible depuis plusieurs résolveurs publics ? */
  async function propagation(userId, name) {
    const d = ownDomain(userId, name);
    return Promise.all(cfg.dns.resolvers.map(async (ip) => {
      const t0 = Date.now();
      try { const mx = await resolve(ip, d.name, 'MX'); return { resolver: resolverName(ip), ip, ok: mx.some((m) => /purelymail/i.test(m.exchange)), ms: Date.now() - t0 }; }
      catch (e) { return { resolver: resolverName(ip), ip, ok: false, ms: Date.now() - t0 }; }
    }));
  }
  const resolverName = (ip) => ({ '8.8.8.8': 'Google', '1.1.1.1': 'Cloudflare', '9.9.9.9': 'Quad9', '208.67.222.222': 'OpenDNS' }[ip] || ip);

  /* ---------- Domaines existants (hébergés ailleurs) ---------- */
  function connect(userId, rawDomain, mode = 'records') {
    const name = String(rawDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!FQDN.test(name)) throw new HttpError(400, 'Entrez un domaine complet, par exemple monentreprise.com.', 'invalid_domain');
    if (!['nameservers', 'records'].includes(mode)) throw new HttpError(400, 'Méthode inconnue.', 'invalid_mode');
    const mine = db.get('SELECT * FROM domains WHERE user_id = ? AND name = ?', userId, name);
    if (mine && mine.status !== 'pending') throw new HttpError(409, 'Ce domaine est déjà dans votre espace.', 'duplicate');
    if (db.get("SELECT 1 FROM domains WHERE name = ? AND status <> 'pending'", name)) throw new HttpError(409, 'Ce domaine appartient déjà à un autre compte Freda.', 'domain_taken');
    let did;
    db.tx(() => {
      if (mine) { did = mine.id; db.run('UPDATE domains SET dns_mode = ? WHERE id = ?', mode, did); }
      else {
        did = 'dom_' + crypto.randomBytes(8).toString('hex');
        const first = !db.get('SELECT 1 FROM domains WHERE user_id = ?', userId);
        db.run('INSERT INTO domains (id, user_id, name, status, external, dns_mode, registered_at, auto_renew, locked, is_primary, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          did, userId, name, 'pending', 1, mode, new Date().toISOString().slice(0, 10), 0, 0, first ? 1 : 0, new Date().toISOString());
        db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'link-2', `Domaine existant ${name} ajouté`, new Date().toISOString().slice(0, 16).replace('T', ' '));
      }
      const have = db.all('SELECT * FROM dns_records WHERE domain_id = ?', did);
      for (const t of MAIL_TEMPLATE) if (!have.some((r) => r.type === t.type && r.name === t.name && r.value === t.value))
        db.run('INSERT INTO dns_records (id, domain_id, type, name, value, ttl, priority, managed, role) VALUES (?,?,?,?,?,?,?,?,?)', id(), did, t.type, t.name, t.value, 3600, t.priority ?? null, 1, t.role);
    });
    return { domain: name, mode, nameservers: cfg.namesilo.nameservers, records: MAIL_TEMPLATE, nameserversAvailable: cfg.namesilo.nameservers.length >= 2 };
  }

  /** Vérifie la connexion en DNS réel : serveurs de noms (mode nameservers) ou enregistrements e-mail (mode records). */
  async function verify(userId, name) {
    const d = ownDomain(userId, name);
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
        if (!txt.some((t) => t.startsWith('v=spf1') && t.includes('purelymail'))) missing.push('SPF');
      }
    } catch (e) { if (e instanceof HttpError) throw e; missing.push('DNS'); }
    if (missing.length) return { connected: false, missing };
    if (db.get("SELECT 1 FROM domains WHERE name = ? AND status <> 'pending' AND id <> ?", d.name, d.id)) throw new HttpError(409, 'Ce domaine a déjà été vérifié par un autre compte Freda.', 'domain_taken');
    db.run("UPDATE domains SET status = 'active', connected_at = ? WHERE id = ?", new Date().toISOString().slice(0, 10), d.id);
    db.run('INSERT INTO activity (user_id, icon, text, at) VALUES (?,?,?,?)', userId, 'badge-check', `Domaine ${d.name} connecté`, new Date().toISOString().slice(0, 16).replace('T', ' '));
    return { connected: true, missing: [] };
  }

  return { list, save, remove, autofix, health, propagation, connect, verify, validateRecord, MAIL_TEMPLATE, ownDomain };
}

module.exports = { createDns, MAIL_TEMPLATE, validateRecord };
