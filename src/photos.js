/**
 * Photos de profil des boîtes Freda Mail.
 * Visibilité : seules les boîtes connectées à l'application (session de boîte) peuvent voir les photos des autres — aucune URL publique.
 * Sécurité : le type est déduit des OCTETS (JPEG / PNG / WebP), jamais de l'en-tête envoyé ; 150 Ko maximum (l'app réduit à 384 px avant l'envoi).
 */
const crypto = require('crypto');
const { HttpError } = require('./errors');

const MAX_BYTES = 150 * 1024;
const MAX_LOOKUP = 50;

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function createPhotos({ db }) {
  return {
    MAX_BYTES,
    async save(mailbox, buf) {
      if (!buf || !buf.length) throw new HttpError(400, 'Aucune image reçue.', 'empty_photo');
      if (buf.length > MAX_BYTES) throw new HttpError(413, 'Photo trop lourde (150 Ko maximum).', 'photo_too_large');
      const type = sniff(buf);
      if (!type) throw new HttpError(415, 'Format non pris en charge : utilisez JPEG, PNG ou WebP.', 'photo_format');
      const version = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      const now = new Date().toISOString();
      await db.run(
        'INSERT INTO mailbox_photos (mailbox_id, content_type, data_b64, version, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (mailbox_id) DO UPDATE SET content_type = excluded.content_type, data_b64 = excluded.data_b64, version = excluded.version, updated_at = excluded.updated_at',
        mailbox.id, type, buf.toString('base64'), version, now,
      );
      return { version, updatedAt: now };
    },
    async remove(mailbox) { await db.run('DELETE FROM mailbox_photos WHERE mailbox_id = ?', mailbox.id); return { ok: true }; },
    /** Photo d'une adresse (boîte active seulement) ou null. */
    async get(address) {
      const row = await db.get(
        "SELECT p.content_type, p.data_b64, p.version FROM mailbox_photos p JOIN mailboxes m ON m.id = p.mailbox_id WHERE m.address = ? AND m.provider_status = 'active'",
        String(address).trim().toLowerCase(),
      );
      return row ? { type: row.content_type, data: Buffer.from(row.data_b64, 'base64'), version: row.version } : null;
    },
    /** Quelles adresses ont une photo ? -> { adresse: version } (l'app ne télécharge que ce qui a changé). */
    async lookup(addresses) {
      const list = [...new Set((Array.isArray(addresses) ? addresses : []).map((a) => String(a).trim().toLowerCase()).filter((a) => a.includes('@') && a.length <= 254))].slice(0, MAX_LOOKUP);
      if (!list.length) return { photos: {} };
      const rows = await db.all(
        `SELECT m.address, p.version FROM mailbox_photos p JOIN mailboxes m ON m.id = p.mailbox_id WHERE m.provider_status = 'active' AND m.address IN (${list.map(() => '?').join(',')})`,
        ...list,
      );
      return { photos: Object.fromEntries(rows.map((r) => [r.address, r.version])) };
    },
  };
}

module.exports = { createPhotos, sniff, MAX_BYTES };
