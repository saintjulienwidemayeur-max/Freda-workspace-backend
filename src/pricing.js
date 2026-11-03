/** Prix de vente = coût revendeur + marge, arrondi à x.99. Les prix affichés au client viennent TOUJOURS d'ici, jamais du navigateur. */
function sellPrice(cost, pricing) {
  const withPct = cost * (1 + pricing.markupPercent / 100);
  const raw = Math.max(withPct, cost + pricing.minMarkup);
  return Math.round((Math.ceil(raw) - 0.01) * 100) / 100;
}

/** Prix de référence barré, purement affichable (jamais facturé) : prix de vente + pourcentage, arrondi à x.99. null si désactivé. */
function compareAt(price, pct) {
  if (!(pct > 0)) return null;
  return Math.round((Math.ceil(price * (1 + pct / 100)) - 0.01) * 100) / 100;
}

/** 1re année au prix d'enregistrement, années suivantes au prix de renouvellement (comme le frontend). */
function totalFor(entry, years) {
  return Math.round((entry.price + entry.renew * (Math.max(1, years) - 1)) * 100) / 100;
}

function createPriceBook({ registrar, cfg }) {
  let cache = null, at = 0;
  async function load() {
    if (cache && Date.now() - at < cfg.pricing.priceCacheMs) return cache;
    const costs = await registrar.getPrices();
    const book = {};
    for (const tld of cfg.tlds) {
      const c = costs[tld];
      if (!c || !(c.registration > 0)) continue;       // extension non vendue chez le registraire : on ne la propose pas
      book[tld] = { tld, cost: c.registration, costRenew: c.renew, price: sellPrice(c.registration, cfg.pricing), renew: sellPrice(c.renew, cfg.pricing) };
      book[tld].compare = compareAt(book[tld].price, cfg.pricing.comparePercent);
    }
    cache = book; at = Date.now();
    return book;
  }
  return { load, invalidate() { cache = null; } };
}

module.exports = { compareAt, sellPrice, totalFor, createPriceBook };
