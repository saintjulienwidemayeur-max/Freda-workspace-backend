/**
 * Offres Freda Mail : durée de paiement au choix (1 à 12 mois) et prix modifiables depuis l'administration.
 *  - Période (« cycle ») : 'monthly' = 1 mois, 'yearly' = 12 mois (2 mois offerts), 'm2' … 'm11' = 2 à 11 mois.
 *  - Prix = prix mensuel × nombre de mois ; 12 mois = prix mensuel × yearlyMonthsBilled (10) : les 2 mois offerts.
 *  - Les prix mensuels enregistrés dans app_settings (clé plan_prices) priment sur ceux du code ; sans réglage, les valeurs par défaut s'appliquent.
 */
const PRICE_LIMITS = [0.5, 1000];

function cycleMonths(cycle) {
  if (cycle === 'monthly') return 1;
  if (cycle === 'yearly') return 12;
  const m = /^m(\d{1,2})$/.exec(String(cycle || ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 2 && n <= 11 ? n : 0;                 // 0 = période inconnue
}
const cycleOf = (months) => (months === 1 ? 'monthly' : months === 12 ? 'yearly' : 'm' + months);
const cycleLabel = (cycle) => { const n = cycleMonths(cycle); return n === 1 ? 'mensuel' : n === 12 ? 'annuel' : `${n} mois`; };

function createPlans({ cfg, db }) {
  const DEFAULTS = Object.fromEntries(Object.values(cfg.plans).filter((p) => !p.free).map((p) => [p.id, p.monthly]));
  const sellable = () => Object.values(cfg.plans).filter((p) => !p.free);

  /** Applique les prix enregistrés à cfg.plans (mémoire du processus) ; appelé au démarrage et après chaque modification. */
  async function load() {
    const row = await db.get("SELECT value FROM app_settings WHERE key = 'plan_prices'");
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch (e) { saved = {}; }
    for (const p of sellable()) p.monthly = Number.isFinite(saved[p.id]) && saved[p.id] >= PRICE_LIMITS[0] ? saved[p.id] : DEFAULTS[p.id];
    return { custom: !!row };
  }
  const ready = db.ready.then(load);
  ready.catch(() => {});

  const view = async () => {
    const { custom } = await ready.then(() => db.get("SELECT 1 AS c FROM app_settings WHERE key = 'plan_prices'").then((r) => ({ custom: !!r })));
    return { custom, limits: PRICE_LIMITS, yearlyMonthsBilled: cfg.pricing.yearlyMonthsBilled, plans: sellable().map((p) => ({ id: p.id, name: p.name, monthly: p.monthly, default: DEFAULTS[p.id], mailboxes: p.mailboxes === Infinity ? null : p.mailboxes, storageGb: p.storageGb || null, perBoxGb: p.perBoxGb || null })) };
  };

  /** Prix mensuels : { starter, business, enterprise } (tous facultatifs) ou { reset: true }. */
  async function save(body) {
    await ready;
    if (body && body.reset === true) { await db.run("DELETE FROM app_settings WHERE key = 'plan_prices'"); await load(); return view(); }
    const prices = body && body.prices;
    if (!prices || typeof prices !== 'object') { const e = new Error('Prix invalides.'); e.code = 'invalid_plans'; throw e; }
    const next = {};
    for (const p of sellable()) {
      const raw = prices[p.id];
      if (raw === undefined) { next[p.id] = p.monthly; continue; }
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(',', '.')) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < PRICE_LIMITS[0] || n > PRICE_LIMITS[1]) { const e = new Error(`Le prix de l’offre ${p.name} doit être un montant entre ${PRICE_LIMITS[0]} $ et ${PRICE_LIMITS[1]} $ par mois.`); e.code = 'invalid_plans'; throw e; }
      next[p.id] = Math.round(n * 100) / 100;
    }
    await db.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', 'plan_prices', JSON.stringify(next), new Date().toISOString());
    await load();
    return view();
  }

  /** Vue publique (le site affiche ces prix) : jamais de donnée interne. */
  async function publicView() {
    await ready;
    return { yearlyMonthsBilled: cfg.pricing.yearlyMonthsBilled, maxMonths: 12, plans: Object.fromEntries(sellable().map((p) => [p.id, { monthly: p.monthly, mailboxes: p.mailboxes === Infinity ? null : p.mailboxes }])) };
  }

  return { ready, load, save, view, publicView };
}

module.exports = { cycleMonths, cycleOf, cycleLabel, createPlans, PRICE_LIMITS };
