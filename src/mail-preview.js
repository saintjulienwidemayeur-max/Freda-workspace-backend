/**
 * Extrait lisible (une ou deux phrases) du début d'un message, pour la notification : on lit seulement les premiers octets du corps (IMAP BODY.PEEK[TEXT]<0.n>),
 * on choisit la partie texte (text/plain de préférence, sinon text/html dépouillé), on décode quoted-printable / base64 et on retire citations, liens et espaces.
 */
const unfold = (h) => String(h || '').replace(/\r?\n[ \t]+/g, ' ');
const headerValue = (h, name) => { const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(unfold(h)); return m ? m[1].trim() : ''; };
const param = (v, name) => { const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(v || ''); return m ? (m[1] ?? m[2]) : ''; };

function decodeTransfer(s, cte, charset) {
  const enc = String(cte || '').toLowerCase().trim();
  let buf;
  if (enc === 'base64') buf = Buffer.from(String(s).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  else if (enc === 'quoted-printable') {
    const t = String(s).replace(/=\r?\n/g, '');
    const bytes = []; for (let i = 0; i < t.length; i++) { if (t[i] === '=' && /^[0-9a-f]{2}$/i.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(...Buffer.from(t[i], 'utf8')); }
    buf = Buffer.from(bytes);
  } else buf = Buffer.from(String(s), 'utf8');
  return /iso-8859-1|latin1|windows-1252/i.test(charset || '') ? buf.toString('latin1') : buf.toString('utf8');
}

const stripHtml = (h) => String(h).replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));

/** Texte brut (non nettoyé) de la meilleure partie, ou ''. `type` et `cte` sont ceux de l'entité courante. */
function bestText(type, cte, charset, boundary, body, depth = 0) {
  if (/^multipart\//i.test(type) && boundary && depth < 4) {
    const parts = String(body).split('--' + boundary).slice(1).filter((p) => !p.startsWith('--'));
    let html = '';
    for (const part of parts) {
      const cut = part.search(/\r?\n\r?\n/);
      const head = cut >= 0 ? part.slice(0, cut) : part, rest = cut >= 0 ? part.slice(cut).replace(/^\r?\n\r?\n/, '') : '';
      const ct = headerValue(head, 'Content-Type') || 'text/plain';
      const t = bestText(ct.split(';')[0].trim(), headerValue(head, 'Content-Transfer-Encoding'), param(ct, 'charset'), param(ct, 'boundary'), rest, depth + 1);
      if (!t) continue;
      if (/^text\/plain/i.test(ct)) return t;
      if (!html) html = t;
    }
    return html;
  }
  if (/^text\/plain/i.test(type) || type === '') return decodeTransfer(body, cte, charset);
  if (/^text\/html/i.test(type)) return stripHtml(decodeTransfer(body, cte, charset));
  return '';
}

function previewText(headerText, bodyText, max = 140) {
  try {
    const ct = headerValue(headerText, 'Content-Type');
    let text = bestText(ct ? ct.split(';')[0].trim() : 'text/plain', headerValue(headerText, 'Content-Transfer-Encoding'), param(ct, 'charset'), param(ct, 'boundary'), bodyText);
    if (/<\/?(html|body|div|p|table|span)\b/i.test(text)) text = stripHtml(text);
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('>') && !/^(le .* a écrit\s*:|on .* wrote:)$/i.test(l) && !/^[-_=*]{3,}$/.test(l));
    const out = lines.join(' ').replace(/https?:\/\/\S+/g, '').replace(/[\u0000-\u001f​-‏﻿]/g, ' ').replace(/\s+/g, ' ').trim();
    return out.length > max ? out.slice(0, max - 1).trimEnd() + '…' : out;
  } catch (e) { return ''; }
}

module.exports = { previewText };
