#!/usr/bin/env node
/** Génère une paire de clés VAPID pour le Web Push (version web de Freda Mail). À lancer UNE fois ; garder la clé privée secrète.
 *    node scripts/generate-vapid.js
 *  Puis, dans Render (service freda-workspace-api > Environment) : VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY. Changer la paire plus tard invalide
 *  tous les abonnements existants (les navigateurs se ré-abonnent à la prochaine connexion). */
const { generateVapidKeys } = require('../src/webpush');
const k = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
