/**
 * Chiffrement des secrets conservés côté serveur (mot de passe de boîte choisi par le client, gardé le temps que sa commande soit exécutée puis supprimé). AES-256-GCM, clé DATA_KEY (32 octets en base64 ou hexadécimal). Hors production, une clé de développement
 * est dérivée de JWT_SECRET ; en production DATA_KEY est obligatoire (voir assertSafe). Format : v1.<iv>.<tag>.<chiffré> (base64url).
 */
const crypto = require('crypto');

function keyFrom(cfg) {
  const raw = String(cfg.dataKey || '').trim();
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('DATA_KEY doit faire 32 octets (64 caractères hexadécimaux ou 44 caractères base64).');
    return buf;
  }
  return crypto.scryptSync(String(cfg.auth.jwtSecret || 'dev'), 'freda-vault-dev', 32);
}

function createVault(cfg) {
  const key = keyFrom(cfg);
  return {
    /** Empreinte HMAC-SHA256 (hex) avec une sous-clé dérivée de DATA_KEY et du libellé : sert à ne conserver que l'empreinte des clés API (inutilisable sans DATA_KEY). */
    mac(label, data) {
      const sub = crypto.createHmac('sha256', key).update('freda-mac:' + label).digest();
      return crypto.createHmac('sha256', sub).update(String(data)).digest('hex');
    },
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(blob) {
      const [v, iv, tag, ct] = String(blob || '').split('.');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Secret illisible.');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

module.exports = { createVault };
