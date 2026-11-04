/**
 * Notifications push du courrier entrant (application iPhone / Android).
 *
 * Pourquoi un service serveur : Apple a cassé IMAP IDLE en arrière-plan et Purelymail n'a pas le certificat Apple (doc Purelymail, FAQ) ; une app mobile
 * ne peut donc pas être prévenue d'un nouveau message sans nous. Principe :
 *  - l'app s'enregistre (jeton APNs / FCM) avec sa session de boîte ; le serveur crée UN mot de passe d'application Purelymail « Freda push » par boîte
 *    (jamais le mot de passe du client, révocable, chiffré au repos) ;
 *  - un observateur IMAP IDLE par boîte (RFC 2177, renouvelé toutes les 25 min) compare UIDNEXT au dernier UID notifié : aucun doublon, rattrapage après
 *    redémarrage, jamais de notification pour une suppression ;
 *  - la notification ne contient par défaut que « Nouveau message » + l'adresse de la boîte (PUSH_PREVIEW=true ajoute expéditeur et objet : ils transitent
 *    alors par Apple / Google) ; les jetons morts (410 / UNREGISTERED) sont supprimés.
 * Réconciliation toutes les 60 s : observateurs démarrés / arrêtés selon les boîtes actives qui ont au moins un appareil (suspension, réactivation,
 * suppression sont donc prises en compte sans crochet). UNE instance (état en mémoire : observateurs IMAP, limiteurs) : une connexion IMAP par boîte surveillée.
 */
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { HttpError } = require('./errors');
const { previewText } = require('./mail-preview');

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref && t.unref(); });
const MAX_DEVICES = 20;
const IDLE_MS = 25 * 60 * 1000;

/** Un échange IMAP ligne à ligne : commandes étiquetées, lignes non étiquetées remises à la commande en cours (ou au gestionnaire « spontané »). */
function connectImap({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = '', cur = null, greeted = false, onGreeting = null;
    const api = {
      sock,
      write: (s) => sock.write(s),
      close: () => sock.destroy(),
      closed: new Promise((r) => { sock.on('close', r); }),
      run(tag, text, { onUntagged, onContinue } = {}) {
        return new Promise((res, rej) => { cur = { tag, lines: [], res, rej, onUntagged, onContinue }; sock.write(`${tag} ${text}\r\n`); });
      },
    };
    const line = (l) => {
      if (!greeted) { greeted = true; return onGreeting && onGreeting(l); }
      if (!cur) return;
      if (l.startsWith(cur.tag + ' ')) { const c = cur; cur = null; return c.res({ ok: /^\S+ OK/i.test(l), line: l, lines: c.lines }); }
      if (l.startsWith('+') && cur.onContinue) { const f = cur.onContinue; cur.onContinue = null; return f(l); }
      cur.lines.push(l); if (cur.onUntagged) cur.onUntagged(l);
    };
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; if (buf.length > 1 << 20) return sock.destroy(); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); line(l); } });
    sock.on('error', (e) => { if (cur) cur.rej(e); reject(e); });
    sock.on('close', () => { if (cur) cur.rej(new Error('imap_closed')); reject(new Error('imap_closed')); });
    onGreeting = (l) => (/^\* OK/i.test(l) ? resolve(api) : (sock.destroy(), reject(new Error('imap_greeting'))));
  });
}

const uidnextOf = (lines) => { for (const l of lines) { const m = /UIDNEXT (\d+)/i.exec(l); if (m) return Number(m[1]); } return null; };
const decodeWords = (s) => String(s).replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc, t) => (enc.toLowerCase() === 'b' ? Buffer.from(t, 'base64').toString('utf8') : Buffer.from(t.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')));

/**
 * Observateur d'UNE boîte. Se reconnecte seul (attente 2 s doublée jusqu'à 5 min) ; s'arrête si l'identifiant est refusé (onDenied).
 * Retourne { stop, ready } ; ready se résout quand l'observateur est en IDLE.
 */
function watchMailbox({ imap, user, pass, getLastUid, setLastUid, onNew, onDenied, preview, log }) {
  let stopped = false, conn = null, readyRes;
  const ready = new Promise((r) => { readyRes = r; });
  async function session() {
    conn = await connectImap(imap);
    const a = await conn.run('w1', 'AUTHENTICATE PLAIN', { onContinue: () => conn.write(Buffer.from(`\0${user}\0${pass}`).toString('base64') + '\r\n') });
    if (!a.ok) { const e = new Error('denied'); e.denied = true; throw e; }
    const sel = await conn.run('w2', 'SELECT INBOX');
    let uidnext = uidnextOf(sel.lines);
    if (!sel.ok || uidnext === null) throw new Error('imap_select');
    let n = 2;
    const catchUp = async () => {
      const last = await getLastUid();
      if (last === null) return await setLastUid(uidnext - 1);                 // première connexion : on part de l'existant, sans notifier
      if (uidnext - 1 <= last) return;
      const info = { count: uidnext - 1 - last };
      if (preview) {
        try {
          const uid = uidnext - 1;
          const f = await conn.run(`w${++n}`, `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT CONTENT-TYPE CONTENT-TRANSFER-ENCODING)])`);
          const text = f.lines.join('\n');
          info.from = decodeWords((/^From: (.*)$/mi.exec(text) || [])[1] || '').replace(/<.*>/, '').replace(/"/g, '').trim();
          info.subject = decodeWords((/^Subject: (.*)$/mi.exec(text) || [])[1] || '');
          if (info.count === 1) {
            try {
              const b = await conn.run(`w${++n}`, `UID FETCH ${uid} (BODY.PEEK[TEXT]<0.3000>)`);
              info.snippet = previewText(text, b.lines.slice(1).join('\n').replace(/\)\s*$/, ''));
            } catch (e) { /* extrait facultatif */ }
          }
        } catch (e) { /* aperçu facultatif */ }
      }
      await setLastUid(uidnext - 1);
      onNew(info);
    };
    await catchUp();
    for (;;) {
      let done = false, timer;
      const send = () => { if (!done) { done = true; clearTimeout(timer); conn.write('DONE\r\n'); } };
      const idle = conn.run(`w${++n}`, 'IDLE', {
        onContinue: () => { readyRes(true); timer = setTimeout(send, IDLE_MS); timer.unref(); },
        onUntagged: (l) => { if (/^\* \d+ EXISTS/i.test(l)) send(); },
      });
      try { await idle; } finally { clearTimeout(timer); }      // le minuteur ne survit jamais à la connexion
      if (stopped) return;
      const st = await conn.run(`w${++n}`, 'STATUS INBOX (UIDNEXT)');
      const u = uidnextOf(st.lines); if (u !== null) uidnext = u;
      await catchUp();
    }
  }
  (async () => {
    let delay = 2000;
    while (!stopped) {
      const startedAt = Date.now();
      try { await session(); }
      catch (e) {
        try { conn && conn.close(); } catch (x) { /* déjà fermée */ }          // jamais de connexion orpheline (même quand l'identifiant est refusé)
        if (stopped) break;
        if (e.denied) { log('warn', 'push_watch_denied', { user }); await onDenied(); break; }
        if (Date.now() - startedAt > 60000) delay = 2000;                // une session longue a réussi : on repart de zéro
        log('warn', 'push_watch_retry', { message: e.message });
      }
      try { conn && conn.close(); } catch (e) { /* déjà fermée */ }
      if (stopped) break;
      await sleep(delay); delay = Math.min(delay * 2, 300000);
    }
  })();
  return { ready, stop() { stopped = true; try { conn && conn.close(); } catch (e) { /* déjà fermée */ } } };
}

function createPush({ cfg, db, log, vault, mail, senders, debounceMs = 1500 }) {
  const pm = mail.provider;
  const watchers = new Map();        // mailboxId -> { w, user }
  const pending = new Map();         // mailboxId -> { count, from, subject, timer }
  const lastRecreate = new Map();
  const locks = new Map();
  const providerLocal = (b) => b.provider_user || b.local_part;
  const tokenOk = { ios: /^[0-9a-f]{32,200}$/i, android: /^[\w:.\-]{20,4096}$/ };
  const idOf = () => 'psh_' + crypto.randomBytes(8).toString('hex');
  const enabled = (platform) => !!(senders && senders[platform]);

  async function locked(key, fn) { const prev = locks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(key, next.catch(() => {})); return next; }

  /** Un seul identifiant de surveillance par boîte : mot de passe d'application Purelymail « Freda push », chiffré. */
  async function ensureCredential(b) {
    return await locked('cred:' + b.id, async () => {
      if ((await db.get('SELECT 1 FROM push_credentials WHERE mailbox_id = ?', b.id))) return;
      const secret = await pm.createAppPassword({ local: providerLocal(b), domain: b.domain, name: 'Freda push' });
      if (!secret) throw new HttpError(502, 'Le serveur de messagerie n’a pas fourni d’identifiant de notification. Réessayez.', 'mail_provider_error');
      await db.run('INSERT INTO push_credentials (mailbox_id, secret_enc, created_at, last_uid) VALUES (?,?,?,NULL)', b.id, vault.encrypt(secret), new Date().toISOString());
    });
  }

  async function register(b, { platform, token } = {}) {
    if (!['ios', 'android'].includes(platform)) throw new HttpError(400, 'Plateforme inconnue (ios ou android).', 'invalid_platform');
    const t = String(token || '').trim();
    if (!tokenOk[platform].test(t)) throw new HttpError(400, 'Jeton de notification invalide.', 'invalid_token');
    if (!enabled(platform)) throw new HttpError(503, 'Les notifications ne sont pas disponibles pour le moment.', 'push_not_configured');
    if (!mail.providerEnabled) throw new HttpError(503, 'La messagerie est en cours d’activation.', 'mailbox_not_ready');
    if (!(await db.get('SELECT 1 FROM push_devices WHERE mailbox_id = ? AND platform = ? AND token = ?', b.id, platform, t)) && (await db.get('SELECT COUNT(*) AS n FROM push_devices WHERE mailbox_id = ?', b.id)).n >= MAX_DEVICES) throw new HttpError(403, `Limite de ${MAX_DEVICES} appareils par boîte atteinte.`, 'device_limit');
    try { await ensureCredential(b); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'Le serveur de messagerie n’a pas accepté la demande. Réessayez.', 'mail_provider_error'); }
    await db.tx(async () => {
      // un même téléphone peut notifier PLUSIEURS comptes (application à comptes multiples) : l'app désenregistre un compte quand on le retire
      if (!(await db.get('SELECT 1 FROM push_devices WHERE mailbox_id = ? AND platform = ? AND token = ?', b.id, platform, t))) await db.run('INSERT INTO push_devices (id, mailbox_id, platform, token, created_at) VALUES (?,?,?,?,?)', idOf(), b.id, platform, t, new Date().toISOString());
    });
    await reconcile();
    return { registered: true };
  }

  async function unregister(b, token) {
    await db.run('DELETE FROM push_devices WHERE mailbox_id = ? AND token = ?', b.id, String(token || ''));
    await reconcile();
    return { registered: false };
  }

  async function dispatch(mailboxId) {
    const p = pending.get(mailboxId); pending.delete(mailboxId);
    const b = await db.get('SELECT * FROM mailboxes WHERE id = ?', mailboxId);
    if (!p || !b) return;
    const single = p.count === 1 && cfg.push.preview && (p.from || p.subject);
    const msg = {
      title: single ? (p.from || b.address) : (p.count > 1 ? `${p.count} nouveaux messages` : 'Nouveau message'),
      body: single ? [p.subject || '(sans objet)', p.snippet].filter(Boolean).join('\n') : b.address,
      data: { kind: 'new_mail', mailbox: b.address, count: p.count, ...(single && p.from ? { from: p.from } : {}) }, collapseId: b.id,
    };
    for (const d of await db.all('SELECT * FROM push_devices WHERE mailbox_id = ?', mailboxId)) {
      const sender = senders && senders[d.platform];
      if (!sender) continue;
      try {
        let r; try { r = await sender.send(d.token, msg); } catch (e) { await sleep(1500); r = await sender.send(d.token, msg); }   // une nouvelle tentative
        if (r.invalid) { await db.run('DELETE FROM push_devices WHERE id = ?', d.id); log('info', 'push_token_removed', { platform: d.platform }); }
      } catch (e) { log('warn', 'push_send_failed', { platform: d.platform, message: e.message }); }
    }
  }

  function notify(mailboxId, info) {
    const cur = pending.get(mailboxId) || { count: 0 };
    cur.count += info.count; cur.from = info.from; cur.subject = info.subject; cur.snippet = info.snippet;      // regroupe les rafales : une notification par fenêtre
    clearTimeout(cur.timer); cur.timer = setTimeout(async () => dispatch(mailboxId).catch(() => {}), debounceMs); cur.timer.unref && cur.timer.unref();
    pending.set(mailboxId, cur);
  }

  function startWatcher(row) {
    const user = row.address;
    const pass = vault.decrypt(row.secret_enc);
    const w = watchMailbox({
      imap: cfg.imap, user, pass, preview: cfg.push.preview, log,
      getLastUid: async () => { const r = await db.get('SELECT last_uid FROM push_credentials WHERE mailbox_id = ?', row.id); return r ? r.last_uid : null; },
      setLastUid: async (uid) => (await db.run('UPDATE push_credentials SET last_uid = ? WHERE mailbox_id = ?', uid, row.id)),
      onNew: (info) => notify(row.id, info),
      onDenied: async () => {                                  // identifiant révoqué / invalide : on l'oublie, la réconciliation en recrée un (au plus 1 fois / 10 min)
        watchers.delete(row.id); await db.run('DELETE FROM push_credentials WHERE mailbox_id = ?', row.id);
      },
    });
    watchers.set(row.id, { w, user });
    return w;
  }

  /** Aligne les observateurs sur la base : boîtes actives avec appareil et identifiant ; crée les identifiants manquants ; supprime ceux devenus inutiles. */
  async function reconcile() {
    return await locked('reconcile', async () => {
      const want = await db.all(`SELECT m.*, c.secret_enc FROM mailboxes m JOIN push_credentials c ON c.mailbox_id = m.id
        WHERE m.provider_status = 'active' AND EXISTS (SELECT 1 FROM push_devices d WHERE d.mailbox_id = m.id)`);
      const wantIds = new Set(want.map((r) => r.id));
      for (const [mid, x] of watchers) if (!wantIds.has(mid)) { x.w.stop(); watchers.delete(mid); }
      for (const row of want) if (!watchers.has(row.id)) startWatcher(row);
      // identifiant à recréer (refusé précédemment) pour les boîtes actives qui ont toujours des appareils
      for (const b of await db.all(`SELECT m.* FROM mailboxes m WHERE m.provider_status = 'active' AND EXISTS (SELECT 1 FROM push_devices d WHERE d.mailbox_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM push_credentials c WHERE c.mailbox_id = m.id)`)) {
        if (Date.now() - (lastRecreate.get(b.id) || 0) < 10 * 60 * 1000) continue;
        lastRecreate.set(b.id, Date.now());
        try { await ensureCredential(b); const row = await db.get('SELECT m.*, c.secret_enc FROM mailboxes m JOIN push_credentials c ON c.mailbox_id = m.id WHERE m.id = ?', b.id); if (row && !watchers.has(row.id)) startWatcher(row); }
        catch (e) { log('warn', 'push_credential_failed', { mailbox: b.address }); }
      }
      // plus aucun appareil : l'identifiant de surveillance est révoqué chez Purelymail puis supprimé (en cas d'échec, retenté au passage suivant)
      for (const c of await db.all(`SELECT c.*, m.local_part, m.provider_user, m.domain, m.provider_status FROM push_credentials c JOIN mailboxes m ON m.id = c.mailbox_id
          WHERE NOT EXISTS (SELECT 1 FROM push_devices d WHERE d.mailbox_id = c.mailbox_id)`)) {
        try { await pm.deleteAppPassword({ local: providerLocal(c), domain: c.domain, appPassword: vault.decrypt(c.secret_enc) }); await db.run('DELETE FROM push_credentials WHERE mailbox_id = ?', c.mailbox_id); }
        catch (e) { log('warn', 'push_credential_cleanup_failed', { mailbox: c.mailbox_id }); }
      }
    });
  }

  let timer = null;
  return {
    enabled, register, unregister, reconcile, notify,
    watchers: () => watchers,
    async start() { await reconcile(); if (!timer) { timer = setInterval(async () => reconcile().catch(() => {}), 60000); timer.unref(); } },
    stop() { clearInterval(timer); timer = null; for (const x of Object.values(senders || {})) { try { x && x.close && x.close(); } catch (e) { /* déjà fermé */ } } for (const x of watchers.values()) x.w.stop(); watchers.clear(); for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); },
  };
}

module.exports = { createPush, watchMailbox };
