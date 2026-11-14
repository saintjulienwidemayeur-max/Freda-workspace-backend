/**
 * Passerelle IMAP / SMTP de l'API publique (/api/v1) et des webhooks : lit et envoie le courrier d'UNE boîte avec son mot de passe d'application « Freda API ».
 * Bibliothèques éprouvées (imapflow, mailparser, nodemailer) : analyse MIME, jeux de caractères et échappements d'en-têtes ne sont pas écrits à la main.
 *
 * Identifiants de message : opaques (base64url de « dossier:uidvalidity:uid »). Si le dossier a été recréé (uidvalidity changé), l'ancien identifiant répond 404
 * au lieu de désigner un autre message. Seuls deux dossiers sont exposés : « inbox » et « sent ».
 * L'expéditeur est toujours la boîte elle-même (jamais choisi par l'appelant) ; l'envoi passe par le SMTP de Purelymail, puis une copie est rangée dans « Envoyés ».
 */
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { HttpError } = require('./errors');

const MAX_SOURCE = 10 * 1024 * 1024;       // message plus gros : 413 (jamais chargé en mémoire)
const MAX_TEXT = 200 * 1024, MAX_HTML = 500 * 1024;
const MAX_PAGE = 50;
const FOLDERS = { inbox: 'INBOX', sent: 'Sent' };

const encodeId = (folder, validity, uid) => Buffer.from(`${folder}:${validity}:${uid}`).toString('base64url');
function decodeId(id) {
  const m = /^(inbox|sent):(\d+):(\d+)$/.exec(Buffer.from(String(id || ''), 'base64url').toString('utf8'));
  if (!m || String(id).length > 100) throw new HttpError(400, 'Identifiant de message invalide.', 'invalid_message_id');
  return { folder: m[1], validity: m[2], uid: Number(m[3]) };
}
const addr = (a) => (a ? { name: a.name || '', address: String(a.address || '').toLowerCase() } : null);
const addrs = (l) => (l || []).map(addr).filter(Boolean);
const clip = (s, n) => { const v = String(s || ''); return v.length > n ? { value: v.slice(0, n), truncated: true } : { value: v, truncated: false }; };

/** « References: <a> <b> » (en-têtes dépliés) -> ['<a>', '<b>'] */
function idsOf(headerText, name) {
  const m = new RegExp(`^${name}:[ \\t]*((?:.*(?:\\r?\\n[ \\t].*)*))`, 'mi').exec(String(headerText || ''));
  return m ? (m[1].match(/<[^<>\s]+>/g) || []) : [];
}
/** Identifiant de fil : racine de References, sinon In-Reply-To, sinon le Message-ID du message lui-même. */
const threadIdOf = (messageId, inReplyTo, references) => (references && references[0]) || inReplyTo || messageId || null;

function createGateway({ cfg, log, tlsOptions }) {   // tlsOptions : réservé aux tests (serveurs à certificat auto-signé)
  const busy = new Map();
  /** Au plus 2 connexions simultanées par boîte : une API ne doit pas pouvoir saturer le serveur de messagerie. */
  async function guarded(user, fn) {
    const n = busy.get(user) || 0;
    if (n >= 2) throw new HttpError(429, 'Trop de requêtes simultanées sur cette boîte. Réessayez dans un instant.', 'busy');
    busy.set(user, n + 1);
    try { return await fn(); } finally { const c = (busy.get(user) || 1) - 1; if (c) busy.set(user, c); else busy.delete(user); }
  }
  const fail = (e, what) => {
    if (e instanceof HttpError) return e;
    log('warn', 'api_mail_failed', { what, code: e.code || e.responseStatus || '', message: String(e.message || '').slice(0, 120) });
    return new HttpError(502, 'Le serveur de messagerie ne répond pas. Réessayez.', 'mail_provider_error');
  };
  async function withImap(creds, what, fn) {
    return await guarded(creds.user, async () => {
      const client = new ImapFlow({ host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure, auth: { user: creds.user, pass: creds.pass }, logger: false, ...(tlsOptions ? { tls: tlsOptions } : {}), socketTimeout: 30000, greetingTimeout: 10000, connectionTimeout: 10000 });
      client.on('error', () => {});
      try { await client.connect(); return await fn(client); }
      catch (e) { throw fail(e, what); }
      finally { try { await client.logout(); } catch (e) { try { client.close(); } catch (x) { /* déjà fermée */ } } }
    });
  }
  async function pathOf(client, folder) {
    if (folder === 'inbox') return 'INBOX';
    const boxes = await client.list();
    const hit = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^(sent|sent items|sent messages|envoy)/i.test(b.name));
    return hit ? hit.path : FOLDERS.sent;
  }
  async function open(client, folder) {
    const path = await pathOf(client, folder);
    const lock = await client.getMailboxLock(path, { readOnly: false });
    return { lock, validity: String(client.mailbox.uidValidity), path };
  }

  const summary = (m, folder, validity) => {
    const env = m.envelope || {};
    const head = m.headers ? m.headers.toString('utf8') : '';
    const refs = idsOf(head, 'References');
    const messageId = env.messageId || (idsOf(head, 'Message-ID')[0] || null);
    const inReplyTo = env.inReplyTo || (idsOf(head, 'In-Reply-To')[0] || null);
    return {
      id: encodeId(folder, validity, m.uid), thread_id: threadIdOf(messageId, inReplyTo, refs), message_id: messageId, in_reply_to: inReplyTo,
      from: addr((env.from || [])[0]), to: addrs(env.to), cc: addrs(env.cc), subject: env.subject || '',
      date: new Date(env.date || m.internalDate || Date.now()).toISOString(), unread: !(m.flags && m.flags.has('\\Seen')), size: m.size || 0,
    };
  };
  const META = { uid: true, flags: true, envelope: true, internalDate: true, size: true, headers: ['references', 'in-reply-to', 'message-id'] };

  /** Liste : plus récents d'abord ; cursor = uid du dernier message de la page précédente (« before »). */
  async function list(creds, { folder = 'inbox', unread = false, limit = 20, before } = {}) {
    const lim = Math.min(MAX_PAGE, Math.max(1, Number(limit) || 20));
    return await withImap(creds, 'list', async (client) => {
      const { lock, validity } = await open(client, folder);
      try {
        const q = unread ? { seen: false } : { all: true };
        if (before) q.uid = `1:${Math.max(1, Number(before) - 1)}`;
        const uids = ((await client.search(q, { uid: true })) || []).sort((a, b) => b - a);
        const page = uids.slice(0, lim);
        const raw = [];
        if (page.length) for await (const m of client.fetch(page.join(','), META, { uid: true })) raw.push(m);
        const items = raw.sort((a, b) => b.uid - a.uid).map((m) => summary(m, folder, validity));   // ordre d'arrivée (les dates d'en-tête sont déclaratives)
        return { messages: items, next_cursor: uids.length > page.length && page.length ? String(page[page.length - 1]) : null, total_matching: uids.length };
      } finally { lock.release(); }
    });
  }

  async function build(client, folder, validity, uid, meta) {
    if ((meta.size || 0) > MAX_SOURCE) throw new HttpError(413, 'Message trop volumineux pour l’API.', 'message_too_large');
    const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!full || !full.source) throw new HttpError(404, 'Message introuvable.', 'not_found');
    const p = await simpleParser(full.source, { skipImageLinks: true });
    const text = clip(p.text, MAX_TEXT), html = p.html ? clip(p.html, MAX_HTML) : null;
    const s = summary(meta, folder, validity);
    return {
      ...s, reply_to: addrs(p.replyTo && p.replyTo.value), references: idsOf(meta.headers ? meta.headers.toString('utf8') : '', 'References'),
      text: text.value, html: html ? html.value : null, truncated: text.truncated || !!(html && html.truncated),
      attachments: (p.attachments || []).map((a) => ({ filename: a.filename || '', content_type: a.contentType || '', size: a.size || 0, inline: a.contentDisposition === 'inline' })),
    };
  }

  async function get(creds, id) {
    const ref = decodeId(id);
    return await withImap(creds, 'get', async (client) => {
      const { lock, validity } = await open(client, ref.folder);
      try {
        if (validity !== ref.validity) throw new HttpError(404, 'Message introuvable.', 'not_found');
        const meta = await client.fetchOne(String(ref.uid), META, { uid: true });
        if (!meta) throw new HttpError(404, 'Message introuvable.', 'not_found');
        return await build(client, ref.folder, validity, ref.uid, meta);
      } finally { lock.release(); }
    });
  }

  /** Messages de la boîte de réception dont l'uid est dans [from, to] (webhooks). */
  async function fetchRange(creds, from, to, max = 20) {
    return await withImap(creds, 'range', async (client) => {
      const { lock, validity } = await open(client, 'inbox');
      try {
        const metas = [];
        for await (const m of client.fetch(`${from}:${to}`, META, { uid: true })) metas.push(m);
        metas.sort((a, b) => a.uid - b.uid);
        const out = [];
        for (const m of metas.slice(-max)) {
          try { out.push(await build(client, 'inbox', validity, m.uid, m)); } catch (e) { out.push({ ...summary(m, 'inbox', validity), text: '', html: null, truncated: false, attachments: [], error: e.code || 'unreadable' }); }
        }
        return out;
      } finally { lock.release(); }
    });
  }

  async function setUnread(creds, id, unread) {
    const ref = decodeId(id);
    return await withImap(creds, 'flag', async (client) => {
      const { lock, validity } = await open(client, ref.folder);
      try {
        if (validity !== ref.validity) throw new HttpError(404, 'Message introuvable.', 'not_found');
        if (!(await client.fetchOne(String(ref.uid), { uid: true }, { uid: true }))) throw new HttpError(404, 'Message introuvable.', 'not_found');
        if (unread) await client.messageFlagsRemove(String(ref.uid), ['\\Seen'], { uid: true }); else await client.messageFlagsAdd(String(ref.uid), ['\\Seen'], { uid: true });
        return { id, unread: !!unread };
      } finally { lock.release(); }
    });
  }

  /**
   * Contexte d'une réponse : { inReplyTo, references, subject, replyTo } à partir d'un identifiant de message OU d'un identifiant de fil (Message-ID racine).
   * Fil inconnu : on envoie quand même avec References = fil (les clients de messagerie regroupent d'après cet en-tête).
   */
  async function replyContext(creds, { messageId, threadId }) {
    return await withImap(creds, 'reply', async (client) => {
      let target = null;
      if (messageId) {
        const ref = decodeId(messageId);
        const { lock, validity } = await open(client, ref.folder);
        try {
          if (validity !== ref.validity) throw new HttpError(404, 'Message à relancer introuvable.', 'not_found');
          const m = await client.fetchOne(String(ref.uid), META, { uid: true });
          if (!m) throw new HttpError(404, 'Message à relancer introuvable.', 'not_found');
          target = { m, folder: ref.folder, uid: ref.uid };
        } finally { lock.release(); }
      } else if (threadId) {
        const { lock } = await open(client, 'inbox');
        try {
          const found = (await client.search({ or: [{ header: { 'message-id': threadId } }, { header: { references: threadId } }] }, { uid: true })) || [];
          if (found.length) { const uid = Math.max(...found); const m = await client.fetchOne(String(uid), META, { uid: true }); if (m) target = { m, folder: 'inbox', uid }; }
        } finally { lock.release(); }
      }
      if (!target) return threadId ? { inReplyTo: threadId, references: [threadId], subject: null, replyTo: null, answered: null } : null;
      const env = target.m.envelope || {};
      const head = target.m.headers ? target.m.headers.toString('utf8') : '';
      const refs = idsOf(head, 'References'), mid = env.messageId || idsOf(head, 'Message-ID')[0] || null;
      const from = addr((env.replyTo || env.from || [])[0]);
      return { inReplyTo: mid, references: [...refs, ...(mid && !refs.includes(mid) ? [mid] : [])].slice(-20), subject: env.subject || '', replyTo: from, answered: target.folder === 'inbox' ? target.uid : null };
    });
  }

  /** Envoie (SMTP) puis range une copie dans « Envoyés » (au mieux : l'envoi a réussi même si la copie échoue). */
  async function send(creds, { fromName, to, cc, bcc, subject, text, html, inReplyTo, references, answered }) {
    const domain = creds.user.split('@')[1];
    const messageId = `<${crypto.randomBytes(16).toString('hex')}@${domain}>`;
    const from = { name: fromName || '', address: creds.user };
    const mail = { from, to, cc, bcc, subject, text, html, messageId, headers: { 'X-Mailer': 'Freda Mail API' }, ...(inReplyTo ? { inReplyTo } : {}), ...(references && references.length ? { references } : {}) };
    const raw = await new MailComposer(mail).compile().build();
    const recipients = [...to, ...(cc || []), ...(bcc || [])].map((r) => (typeof r === 'string' ? r : r.address));
    const transport = nodemailer.createTransport({ host: cfg.tunnel.smtpHost, port: cfg.tunnel.smtpPort, secure: cfg.tunnel.smtpSecure, auth: { user: creds.user, pass: creds.pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000, ...(tlsOptions ? { tls: tlsOptions } : {}) });
    let info;
    try { info = await guarded(creds.user, () => transport.sendMail({ envelope: { from: creds.user, to: recipients }, raw })); }
    catch (e) {
      if (e instanceof HttpError) throw e;
      log('warn', 'api_send_failed', { code: e.code || '', response: String(e.response || e.message || '').slice(0, 120) });
      if (e.responseCode >= 500 && e.responseCode < 600 && e.rejected && e.rejected.length) throw new HttpError(422, 'Des destinataires ont été refusés par le serveur.', 'recipient_rejected', { rejected: e.rejected });
      throw new HttpError(502, 'Le serveur de messagerie a refusé ou n’a pas répondu. Réessayez.', 'mail_provider_error');
    } finally { try { transport.close(); } catch (e) { /* déjà fermé */ } }
    let saved = false;
    try {
      await withImap(creds, 'sent-copy', async (client) => {
        await client.append(await pathOf(client, 'sent'), raw, ['\\Seen']);
        if (answered) { const { lock } = await open(client, 'inbox'); try { await client.messageFlagsAdd(String(answered), ['\\Answered'], { uid: true }); } finally { lock.release(); } }
      });
      saved = true;
    } catch (e) { log('warn', 'api_sent_copy_failed', { message: String(e.message || '').slice(0, 120) }); }   // copie facultative : l'envoi a réussi
    return { message_id: messageId, accepted: (info.accepted || []).map(String), rejected: (info.rejected || []).map(String), saved_to_sent: saved };
  }

  return { list, get, fetchRange, setUnread, replyContext, send };
}

module.exports = { createGateway, encodeId, decodeId, idsOf, threadIdOf };
