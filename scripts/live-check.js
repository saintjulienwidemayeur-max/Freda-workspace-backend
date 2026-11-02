#!/usr/bin/env node
/**
 * Vérification en LECTURE SEULE avec votre vraie clé NameSilo (aucun achat, aucun débit) :
 *   NAMESILO_API_KEY=... node scripts/live-check.js [domaine.com ...]
 * Teste : clé valide, solde, tarifs revendeur, disponibilité, et affiche la marge que vous obtiendriez.
 */
const { loadConfig } = require('../src/config');
const { createClient } = require('../src/namesilo');
const { sellPrice } = require('../src/pricing');

(async () => {
  const cfg = loadConfig();
  if (!cfg.namesilo.key) { console.error('NAMESILO_API_KEY manquante.'); process.exit(1); }
  cfg.namesilo.dryRun = true;                    // garantit qu'aucune opération d'écriture n'est possible
  const ns = createClient(cfg.namesilo);
  try {
    console.log('Solde du compte :', (await ns.balance()).toFixed(2), 'USD');
    const prices = await ns.getPrices();
    console.log('\nExtension   coût enreg.  coût renouv.  prix de vente (enreg. / renouv.)');
    for (const tld of cfg.tlds) {
      const p = prices[tld];
      console.log(tld.padEnd(10), p ? String(p.registration).padEnd(11) + String(p.renew).padEnd(13) + sellPrice(p.registration, cfg.pricing) + ' / ' + sellPrice(p.renew, cfg.pricing) : 'non vendue chez NameSilo');
    }
    const test = process.argv.slice(2).length ? process.argv.slice(2) : ['google.com', 'freda-test-' + Date.now() + '.com'];
    const r = await ns.checkAvailability(test);
    console.log('\nDisponibilité :', JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('Échec :', e.message);
    process.exit(1);
  }
})();
