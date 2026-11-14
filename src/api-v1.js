/**
 * API publique REST /api/v1 pour agents IA (Zapier, Make, n8n, Claude, ChatGPT, Gemini, scripts personnalisés) : lire et répondre au courrier d'UNE boîte.
 * Authentification : en-tête « Authorization: Bearer fmk_… » (clé créée dans Paramètres › Intégrations & API du webmail).
 *
 * Protections :
 *  - portée de la clé : « read » (lecture seule) ou « read_send » ; une clé ne voit que sa boîte ;
 *  - limites : 60 requêtes / minute / clé, 10 envois / minute et 200 envois / jour / boîte (API_DAILY_SENDS), 50 destinataires max par message, corps ≤ 1 Mo ;
 *    échecs d'authentification : 20 / 10 minutes / IP (429) ; en-têtes X-RateLimit-* et Retry-After ;
 *  - l'expéditeur est toujours la boîte (jamais choisi par l'appelant), en-têtes validés (pas d'injection de lignes) ;
 *  - Idempotency-Key facultatif sur l'envoi : une nouvelle tentative (réseau, agent qui rejoue) ne renvoie pas le message deux fois.
 */
const { HttpError } = require('./errors');

/** Fenêtre glissante : consume(key) -> { ok, remaining, resetSec }. */
function slidingWindow(max, windowMs) {
  const hits = new Map();
  return {
    max,
    consume(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      const ok = arr.length < max;
      if (ok) arr.push(now);
      hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      return { ok, remaining: Math.max(0, max - arr.length), resetSec: arr.length ? Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)) : 1 };
    },
    peekFail: (key) => { const now = Date.now(); return (hits.get(key) || []).filter((t) => now - t < windowMs).length >= max; },
    fail(key) { const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs); arr.push(now); hits.set(key, arr); },
  };
}

const EMAIL_RE = /^[^\s@<>"',;()\[\]\\]{1,64}@[^\s@<>"',;()\[\]\\]{1,253}\.[^\s@<>"',;()\[\]\\]{2,63}$/;
const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/;

function parseRecipients(v, field) {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((r) => {
    const address = String(typeof r === 'string' ? r : (r && r.address) || '').trim().toLowerCase();
    const name = typeof r === 'object' && r && r.name !== undefined ? String(r.name).trim() : '';
    if (address.length > 254 || !EMAIL_RE.test(address)) throw new HttpError(400, `Adresse invalide dans « ${field} ».`, 'invalid_recipient');
    if (name.length > 100 || CTRL.test(name)) throw new HttpError(400, `Nom invalide dans « ${field} ».`, 'invalid_recipient');
    return name ? { name, address } : address;
  });
}

function createApiV1({ cfg, db, keys, gateway, log }) {
  const dailyCap = cfg.api.dailySends;
  const perKey = slidingWindow(60, 60_000);
  const sendMinute = slidingWindow(10, 60_000);
  const authFails = slidingWindow(20, 10 * 60_000);
  const idem = new Map();   // clé API + Idempotency-Key -> { at, out }
  const tooMany = (what, r) => Object.assign(new HttpError(429, what, 'rate_limited'), { headers: { 'Retry-After': String(r.resetSec) } });

  /** Authentifie la requête (Bearer fmk_…) et applique la limite par clé. `scope` : 'read' (toutes les clés) ou 'read_send'. Renseigne les en-têtes X-RateLimit-*. */
  async function authorize(req, ip, scope, ctx) {
    if (authFails.peekFail(ip)) throw Object.assign(new HttpError(429, 'Trop de clés invalides. Réessayez plus tard.', 'rate_limited'), { headers: { 'Retry-After': '600' } });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    let auth;
    try { if (!m) throw new HttpError(401, 'Clé API manquante : en-tête « Authorization: Bearer fmk_… ».', 'invalid_api_key'); auth = await keys.authenticate(m[1].trim()); }
    catch (e) { if (e.status === 401) authFails.fail(ip); throw e; }
    const r = perKey.consume(auth.key.id);
    Object.assign(ctx.headers, { 'X-RateLimit-Limit': String(perKey.max), 'X-RateLimit-Remaining': String(r.remaining), 'X-RateLimit-Reset': String(r.resetSec) });
    if (!r.ok) throw tooMany(`Limite de ${perKey.max} requêtes par minute atteinte.`, r);
    if (scope === 'read_send' && auth.key.scope !== 'read_send') throw new HttpError(403, 'Cette clé est en lecture seule : créez une clé « Lecture et envoi ».', 'insufficient_scope');
    let creds = await keys.credentialFor(auth.mailbox);
    if (!creds) {   // identifiant d'accès révoqué côté messagerie : recréé à la volée (les clés de l'utilisateur restent valables)
      try { await keys.ensureCredential(auth.mailbox); creds = await keys.credentialFor(auth.mailbox); } catch (e) { /* ci-dessous */ }
      if (!creds) throw new HttpError(503, 'La messagerie est momentanément indisponible. Réessayez.', 'mail_provider_error');
    }
    return { ...auth, creds };
  }

  const me = async (a) => ({
    mailbox: a.mailbox.address, name: a.mailbox.name || '', key: { id: a.key.id, name: a.key.name, scope: a.key.scope },
    limits: { requests_per_minute: perKey.max, sends_per_minute: sendMinute.max, sends_per_day: dailyCap, max_recipients: 50 },
  });

  async function listMessages(a, q) {
    const folder = q.get('folder') || 'inbox';
    if (!['inbox', 'sent'].includes(folder)) throw new HttpError(400, 'Dossier inconnu : « inbox » ou « sent ».', 'invalid_folder');
    const unread = q.get('unread');
    if (unread !== null && !['true', 'false', '1', '0'].includes(unread)) throw new HttpError(400, 'Paramètre « unread » : true ou false.', 'invalid_query');
    const limit = q.get('limit');
    if (limit !== null && !(/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 50)) throw new HttpError(400, 'Paramètre « limit » : entier de 1 à 50.', 'invalid_query');
    const cursor = q.get('cursor');
    if (cursor !== null && !/^\d{1,12}$/.test(cursor)) throw new HttpError(400, 'Curseur invalide.', 'invalid_query');
    return await gateway.list(a.creds, { folder, unread: unread === 'true' || unread === '1', limit: limit ? Number(limit) : 20, before: cursor ? Number(cursor) : undefined });
  }
  const getMessage = (a, id) => gateway.get(a.creds, id);

  async function markRead(a, id, body) {
    if (typeof body.unread !== 'boolean') throw new HttpError(400, 'Champ « unread » (booléen) requis.', 'invalid_body');
    if (a.key.scope !== 'read_send') throw new HttpError(403, 'Cette clé est en lecture seule : créez une clé « Lecture et envoi ».', 'insufficient_scope');
    return await gateway.setUnread(a.creds, id, body.unread);
  }

  async function send(a, body, idemKey) {
    if (idemKey !== undefined && !/^[\w.:-]{8,100}$/.test(idemKey)) throw new HttpError(400, 'Idempotency-Key : 8 à 100 caractères (lettres, chiffres, . _ : -).', 'invalid_idempotency_key');
    const ik = idemKey ? a.key.id + ':' + idemKey : null;
    if (ik && idem.has(ik)) return { ...idem.get(ik).out, idempotent_replay: true };
    const to = parseRecipients(body.to, 'to'), cc = parseRecipients(body.cc, 'cc'), bcc = parseRecipients(body.bcc, 'bcc');
    if (to.length + cc.length + bcc.length > 50) throw new HttpError(400, 'Maximum 50 destinataires par message.', 'too_many_recipients');
    const text = body.text === undefined || body.text === null ? '' : body.text, html = body.html === undefined || body.html === null ? '' : body.html;
    if (typeof text !== 'string' || typeof html !== 'string') throw new HttpError(400, 'Les champs « text » et « html » sont des chaînes.', 'invalid_body');
    if (!text.trim() && !html.trim()) throw new HttpError(400, 'Le message est vide : fournissez « text » ou « html ».', 'invalid_body');
    if (text.length > 500_000 || html.length > 800_000) throw new HttpError(413, 'Corps du message trop long.', 'message_too_large');
    let subject = body.subject === undefined || body.subject === null ? undefined : body.subject;
    if (subject !== undefined && (typeof subject !== 'string' || subject.length > 400 || CTRL.test(subject))) throw new HttpError(400, 'Objet invalide (400 caractères, sur une seule ligne).', 'invalid_subject');
    const replyId = body.reply_to_message_id, thread = body.thread_id;
    if (replyId !== undefined && (typeof replyId !== 'string' || replyId.length > 100)) throw new HttpError(400, 'reply_to_message_id invalide.', 'invalid_message_id');
    let threadId;
    if (thread !== undefined) {
      const t = String(thread).trim();
      if (t.length > 300 || CTRL.test(t) || /[<>\s]/.test(t.replace(/^<|>$/g, ''))) throw new HttpError(400, 'thread_id invalide.', 'invalid_thread_id');
      threadId = t.startsWith('<') ? t : `<${t}>`;
    }
    let ctxReply = null;
    if (replyId || threadId) ctxReply = await gateway.replyContext(a.creds, { messageId: replyId, threadId });
    let recipients = to;
    if (!recipients.length && ctxReply && ctxReply.replyTo && ctxReply.replyTo.address) recipients = [ctxReply.replyTo.name ? ctxReply.replyTo : ctxReply.replyTo.address];
    if (!recipients.length) throw new HttpError(400, 'Aucun destinataire : renseignez « to » (ou répondez à un message).', 'no_recipient');
    if (subject === undefined) subject = ctxReply && ctxReply.subject !== null ? (/^re:/i.test(ctxReply.subject) ? ctxReply.subject : 'Re: ' + (ctxReply.subject || '')) : '';
    if (!String(subject).trim() && !ctxReply) throw new HttpError(400, 'Objet requis pour un nouveau message.', 'invalid_subject');

    const m = sendMinute.consume(a.mailbox.id);
    if (!m.ok) throw tooMany(`Limite de ${sendMinute.max} envois par minute atteinte.`, m);
    const day = new Date().toISOString().slice(0, 10);
    const used = await db.get('INSERT INTO api_usage (mailbox_id, day, sends) VALUES (?,?,1) ON CONFLICT (mailbox_id, day) DO UPDATE SET sends = api_usage.sends + 1 RETURNING sends', a.mailbox.id, day);
    const refund = () => db.run('UPDATE api_usage SET sends = sends - 1 WHERE mailbox_id = ? AND day = ? AND sends > 0', a.mailbox.id, day).catch(() => {});
    if (used.sends > dailyCap) { await refund(); throw Object.assign(new HttpError(429, `Limite de ${dailyCap} envois par jour atteinte pour cette boîte.`, 'daily_limit'), { headers: { 'Retry-After': '3600' } }); }
    let out;
    try {
      out = await gateway.send(a.creds, { fromName: a.mailbox.name || '', to: recipients, cc, bcc, subject, text: text || undefined, html: html || undefined, inReplyTo: ctxReply && ctxReply.inReplyTo, references: ctxReply && ctxReply.references, answered: ctxReply && ctxReply.answered });
    } catch (e) { await refund(); throw e; }
    log('info', 'api_message_sent', { mailbox: a.mailbox.address, recipients: recipients.length + cc.length + bcc.length, reply: !!ctxReply });
    const res = { ...out, thread_id: ctxReply && ctxReply.references && ctxReply.references[0] ? ctxReply.references[0] : out.message_id, status: 'sent' };
    if (ik) { idem.set(ik, { at: Date.now(), out: res }); if (idem.size > 2000) for (const [k, v] of idem) if (Date.now() - v.at > 24 * 3600_000) idem.delete(k); }
    return res;
  }

  return { authorize, me, listMessages, getMessage, markRead, send, limits: { perKey: perKey.max, sendsPerMinute: sendMinute.max, sendsPerDay: dailyCap } };
}

module.exports = { createApiV1, slidingWindow, parseRecipients };
