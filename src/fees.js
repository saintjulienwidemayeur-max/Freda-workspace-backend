/**
 * Frais de traitement des paiements, ajoutés au montant de la commande (jamais au crédit du solde ni au prix de l'offre).
 *  - Carte bancaire : 3,5 % + 0,40 $ ;  MonCash / NatCash : 6 %.  Le paiement par solde Freda n'a aucun frais.
 * Montants en dollars US, arrondis au cent. Calculés côté serveur uniquement.
 */
const CARD = { rate: 0.035, fixed: 0.40 };
const MOBILE = { rate: 0.06 };
const cents = (n) => Math.round(Number(n) * 100);
const cardFee = (amount) => cents(amount) > 0 ? Math.round(cents(amount) * CARD.rate + CARD.fixed * 100) / 100 : 0;
const mobileFee = (amount) => cents(amount) > 0 ? Math.round(cents(amount) * MOBILE.rate) / 100 : 0;
module.exports = { CARD, MOBILE, cardFee, mobileFee };
