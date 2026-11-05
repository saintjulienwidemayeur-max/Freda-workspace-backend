/**
 * Solde prépayé d'un client (USD). MonCash et NatCash ne permettent aucun prélèvement automatique : le client recharge son solde
 * (commande « topup » payée par MonCash / NatCash), puis ses offres et renouvellements sont payés avec ce solde.
 * Journal d'écritures (balance_entries) : le solde est la somme ; une écriture par commande et par type (index unique) donc jamais de double crédit / débit.
 */
const crypto = require('crypto');

const r2 = (n) => Math.round(n * 100) / 100;

function createBalance({ db }) {
  const id = () => 'bal_' + crypto.randomBytes(8).toString('hex');
  async function get(userId) {
    const r = await db.get('SELECT COALESCE(SUM(amount), 0) AS b FROM balance_entries WHERE user_id = ?', userId);
    return r2(Number(r.b) || 0);
  }
  /** Crédite le solde. Retourne false si cette commande a déjà été créditée pour ce type (rejeu d'un webhook, deux vérifications simultanées…). */
  async function credit(userId, amount, { kind = 'topup', orderId = '', note = '' } = {}) {
    amount = r2(amount);
    if (!(amount > 0)) return false;
    const res = await db.run('INSERT INTO balance_entries (id, user_id, amount, kind, order_id, note, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', id(), userId, amount, kind, orderId, note, new Date().toISOString());
    return res.changes > 0;
  }
  /** Débite le solde si, et seulement si, il suffit (ligne du client verrouillée : deux achats simultanés ne dépensent jamais deux fois le même argent). */
  async function debit(userId, amount, { orderId = '', note = '' } = {}) {
    amount = r2(amount);
    if (!(amount > 0)) return false;
    return await db.tx(async () => {
      await db.get('SELECT id FROM users WHERE id = ? FOR UPDATE', userId);
      if ((await get(userId)) < amount - 0.00001) return false;
      const res = await db.run('INSERT INTO balance_entries (id, user_id, amount, kind, order_id, note, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', id(), userId, -amount, 'charge', orderId, note, new Date().toISOString());
      return res.changes > 0;
    });
  }
  async function entries(userId, limit = 30) {
    return (await db.all('SELECT id, amount, kind, note, created_at FROM balance_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', userId, limit))
      .map((e) => ({ id: e.id, amount: r2(e.amount), kind: e.kind, note: e.note, at: e.created_at }));
  }
  async function autoPay(userId) { const u = await db.get('SELECT auto_pay_balance FROM users WHERE id = ?', userId); return !!(u && u.auto_pay_balance); }
  async function setAutoPay(userId, on) { await db.run('UPDATE users SET auto_pay_balance = ? WHERE id = ?', on ? 1 : 0, userId); return !!on; }
  async function total() {
    const r = await db.get('SELECT COALESCE(SUM(b), 0) AS s, COUNT(*) AS n FROM (SELECT SUM(amount) AS b FROM balance_entries GROUP BY user_id HAVING SUM(amount) > 0.005) t');
    return { total: r2(Number(r.s) || 0), customers: Number(r.n) || 0 };
  }
  return { get, credit, debit, entries, autoPay, setAutoPay, total };
}

module.exports = { createBalance };
