/** Configuration lue dans les variables d'environnement (voir backend/.env.example). */
function list(v, fallback) { return String(v || fallback).split(',').map((s) => s.trim()).filter(Boolean); }

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  // NameSilo ne fournit pas toujours de sandbox : on travaille avec la vraie API en lecture seule.
  // dry-run (défaut) = recherche, prix et solde RÉELS ; l'enregistrement et le verrouillage sont SIMULÉS (aucun achat, aucun débit).
  const mode = env.NAMESILO_MODE === 'live' ? 'live' : 'dry-run';
  const cfg = {
    nodeEnv,
    port: Number(env.PORT) || 8787,
    allowedOrigins: list(env.ALLOWED_ORIGINS, 'http://localhost:8080'),
    dataFile: env.DATA_FILE || './data/store.json',
    namesilo: {
      mode,
      dryRun: mode !== 'live',
      key: env.NAMESILO_API_KEY || '',
      baseUrl: env.NAMESILO_BASE_URL || 'https://www.namesilo.com/api',
      contactId: env.NAMESILO_CONTACT_ID || '',          // contact WHOIS par défaut du compte revendeur
      nameservers: list(env.NAMESERVERS, ''),            // ex. ns1.fredaworkspace.com,ns2.fredaworkspace.com ; vide = serveurs NameSilo
      timeoutMs: Number(env.NAMESILO_TIMEOUT_MS) || 20000,
    },
    pricing: {
      markupPercent: Number(env.PRICE_MARKUP_PERCENT ?? 35),
      minMarkup: Number(env.PRICE_MIN_MARKUP ?? 1.5),    // marge minimale en USD
      priceCacheMs: Number(env.PRICE_CACHE_MS) || 6 * 3600 * 1000,
      htgRate: Number(env.HTG_RATE) || 132.5,
    },
    tlds: list(env.DOMAIN_TLDS, '.com,.net,.org,.online,.site,.co,.store,.tech,.io'),
    maxYears: Number(env.MAX_YEARS) || 10,
    auth: { mode: env.AUTH_MODE || 'jwt', jwtSecret: env.JWT_SECRET || '' },
    payments: { provider: env.PAYMENTS_PROVIDER || 'demo' },
  };
  return cfg;
}

/** Refuse de démarrer dans une configuration dangereuse (achats réels avec faux paiements, etc.). */
function assertSafe(cfg) {
  const errors = [];
  if (!cfg.namesilo.key) errors.push('NAMESILO_API_KEY manquante.');
  if (cfg.namesilo.mode === 'live' && cfg.payments.provider === 'demo') errors.push('NAMESILO_MODE=live avec PAYMENTS_PROVIDER=demo : des domaines réels seraient achetés sans vrai paiement.');
  if (cfg.auth.mode === 'demo' && cfg.nodeEnv === 'production') errors.push('AUTH_MODE=demo interdit avec NODE_ENV=production.');
  if (cfg.auth.mode === 'jwt' && cfg.auth.jwtSecret.length < 32) errors.push('JWT_SECRET (32 caractères minimum) requis avec AUTH_MODE=jwt.');
  return errors;
}

module.exports = { loadConfig, assertSafe };
