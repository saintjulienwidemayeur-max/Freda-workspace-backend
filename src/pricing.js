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

const LIMITS = { markupPercent: [0, 300], minMarkup: [0, 50] };

/**
 * Carnet de prix. La marge (pourcentage + minimum en $) peut être modifiée depuis l'administration : elle est enregistrée dans app_settings
 * et prime sur les variables d'environnement (qui restent la valeur par défaut). Chaque changement s'applique tout de suite aux nouveaux devis.
 */
function createPriceBook({ registrar, cfg, db }) {
  let cache = null, at = 0, costs = null, costsAt = 0;
  const defaults = () => ({ markupPercent: cfg.pricing.markupPercent, minMarkup: cfg.pricing.minMarkup });

  async function settings() {
    const d = defaults();
    if (!db) return { ...d, custom: false };
    const rows = await db.all("SELECT key, value FROM app_settings WHERE key IN ('markup_percent', 'min_markup')");
    const m = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    const pct = Number.isFinite(m.markup_percent) ? m.markup_percent : d.markupPercent;
    const min = Number.isFinite(m.min_markup) ? m.min_markup : d.minMarkup;
    return { markupPercent: pct, minMarkup: min, custom: rows.length > 0 };
  }

  /** Valide et enregistre la marge ; { reset: true } revient aux valeurs par défaut. */
  async function save({ markupPercent, minMarkup, reset }) {
    if (!db) throw new Error('Base de données requise.');
    if (reset) { await db.run("DELETE FROM app_settings WHERE key IN ('markup_percent', 'min_markup')"); cache = null; return settings(); }
    const v = validate({ markupPercent, minMarkup });
    const now = new Date().toISOString();
    for (const [k, val] of [['markup_percent', v.markupPercent], ['min_markup', v.minMarkup]]) {
      await db.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', k, String(val), now);
    }
    cache = null;
    return settings();
  }

  async function rawCosts() {
    if (costs && Date.now() - costsAt < cfg.pricing.priceCacheMs) return costs;
    costs = await registrar.getPrices(); costsAt = Date.now();
    return costs;
  }

  function build(raw, pricing) {
    const book = {};
    for (const tld of cfg.tlds) {
      const c = raw[tld];
      if (!c || !(c.registration > 0)) continue;       // extension non vendue chez le registraire : on ne la propose pas
      book[tld] = { tld, cost: c.registration, costRenew: c.renew, price: sellPrice(c.registration, pricing), renew: sellPrice(c.renew, pricing) };
      book[tld].compare = compareAt(book[tld].price, cfg.pricing.comparePercent);
    }
    return book;
  }

  async function load() {
    if (cache && Date.now() - at < cfg.pricing.priceCacheMs) return cache;
    const s = await settings();
    cache = build(await rawCosts(), { markupPercent: s.markupPercent, minMarkup: s.minMarkup }); at = Date.now();
    return cache;
  }

  /** Aperçu SANS enregistrer : les prix que donneraient ces valeurs (undefined = valeur actuelle). */
  async function preview(candidate = {}) {
    const cur = await settings();
    const v = validate({ markupPercent: candidate.markupPercent ?? cur.markupPercent, minMarkup: candidate.minMarkup ?? cur.minMarkup });
    return { pricing: v, book: build(await rawCosts(), v) };
  }

  return { load, settings, save, preview, defaults, invalidate() { cache = null; costs = null; } };
}

/** Marge : pourcentage entre 0 et 300, minimum entre 0 et 50 $ ; refuse tout ce qui n'est pas un nombre. */
function validate({ markupPercent, minMarkup }) {
  const out = {};
  for (const [k, val] of [['markupPercent', markupPercent], ['minMarkup', minMarkup]]) {
    const n = typeof val === 'string' && val.trim() !== '' ? Number(val.replace(',', '.')) : val;
    const [lo, hi] = LIMITS[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) {
      const e = new Error(k === 'markupPercent' ? `Le pourcentage de marge doit être un nombre entre ${lo} et ${hi}.` : `Le minimum de marge doit être un montant entre ${lo} $ et ${hi} $.`);
      e.code = 'invalid_pricing'; throw e;
    }
    out[k] = Math.round(n * 100) / 100;
  }
  return out;
}

module.exports = { compareAt, sellPrice, totalFor, createPriceBook, validatePricing: validate };
