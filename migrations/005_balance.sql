-- Solde prépayé (MonCash / NatCash ne prélèvent pas tout seuls) : un journal d'écritures, le solde est la somme. Montants en USD.
--   topup = recharge payée par MonCash / NatCash ; charge = achat ou renouvellement payé avec le solde (négatif) ;
--   refund = remboursement crédité sur le solde ; adjust = correction manuelle.
-- Un même type d'écriture n'existe qu'une fois par commande (jamais de double crédit ni de double débit).
CREATE TABLE balance_entries (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount DOUBLE PRECISION NOT NULL, kind TEXT NOT NULL,
  order_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX balance_user ON balance_entries(user_id, created_at);
CREATE UNIQUE INDEX balance_order_kind ON balance_entries(order_id, kind) WHERE order_id <> '';
ALTER TABLE balance_entries ENABLE ROW LEVEL SECURITY;
-- 1 = les offres et renouvellements de domaine sont payés automatiquement avec le solde dès qu'il suffit
ALTER TABLE users ADD COLUMN auto_pay_balance INTEGER NOT NULL DEFAULT 1;
