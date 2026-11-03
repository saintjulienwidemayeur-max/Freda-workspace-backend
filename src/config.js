/** Configuration lue dans les variables d'environnement (voir .env.example). */
const list = (v, fallback) => String(v || fallback).split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

/** Offres Freda Mail (source de vérité des prix : le serveur, jamais le navigateur). Miroir de assets/js/config.js du frontend. */
const PLANS = {
  starter: { id: 'starter', name: 'Starter', monthly: 2.99, mailboxes: 1, storageGb: 2 },
  business: { id: 'business', name: 'Business', monthly: 9.99, mailboxes: 5, storageGb: 15 },
  enterprise: { id: 'enterprise', name: 'Enterprise', monthly: 30, mailboxes: Infinity, perBoxGb: 5 },
};

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  // NameSilo ne fournit pas toujours de sandbox : on travaille avec la vraie API en lecture seule.
  // dry-run (défaut) = recherche, prix et solde RÉELS ; enregistrement, verrouillage, renouvellement et DNS sont SIMULÉS.
  const mode = env.NAMESILO_MODE === 'live' ? 'live' : 'dry-run';
  return {
    nodeEnv,
    port: Number(env.PORT) || 8787,
    appUrl: (env.APP_URL || 'https://fredaworkspace.com').replace(/\/$/, ''),     // site (frontend)
    apiUrl: (env.API_URL || 'http://localhost:8787').replace(/\/$/, ''),          // URL publique de cette API (rappels OAuth)
    allowedOrigins: list(env.ALLOWED_ORIGINS, 'http://localhost:8080'),
    dbFile: env.DB_FILE || './data/freda.db',
    adminToken: env.ADMIN_TOKEN || '',
    namesilo: {
      mode,
      dryRun: mode !== 'live',
      key: env.NAMESILO_API_KEY || '',
      baseUrl: env.NAMESILO_BASE_URL || 'https://www.namesilo.com/api',
      contactId: env.NAMESILO_CONTACT_ID || '',
      nameservers: list(env.NAMESERVERS, ''),   // serveurs de noms Freda Connect (≥ 2). Vide = serveurs NameSilo.
      timeoutMs: Number(env.NAMESILO_TIMEOUT_MS) || 20000,
    },
    pricing: {
      markupPercent: Number(env.PRICE_MARKUP_PERCENT ?? 35),
      minMarkup: Number(env.PRICE_MIN_MARKUP ?? 1.5),
      priceCacheMs: Number(env.PRICE_CACHE_MS) || 6 * 3600 * 1000,
      htgRate: Number(env.HTG_RATE) || 132.5,
      yearlyMonthsBilled: Number(env.YEARLY_MONTHS_BILLED) || 10,
    },
    plans: PLANS,
    tlds: list(env.DOMAIN_TLDS, '.com,.net,.org,.online,.site,.co,.store,.tech,.io'),
    maxYears: Number(env.MAX_YEARS) || 10,
    auth: { mode: env.AUTH_MODE || 'jwt', jwtSecret: env.JWT_SECRET || '', tokenTtlHours: Number(env.JWT_TTL_HOURS) || 24 * 7 },
    google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', userInfoUrl: env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo' },
    mailer: { provider: env.MAILER || 'console', brevoKey: env.BREVO_API_KEY || '', brevoUrl: env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email', senderEmail: env.MAIL_FROM || 'no-reply@fredaworkspace.com', senderName: env.MAIL_FROM_NAME || 'Freda Workspace' },
    payments: {
      provider: env.PAYMENTS_PROVIDER || 'demo',                   // demo | paym
      stripe: { secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '', baseUrl: env.STRIPE_BASE_URL || 'https://api.stripe.com' },
      paym: { clientId: env.PAYM_CLIENT_ID || '', clientSecret: env.PAYM_CLIENT_SECRET || '', baseUrl: env.PAYM_BASE_URL || 'https://plopplop.solutionip.app' },
    },
    dataKey: env.DATA_KEY || '',
    imap: { host: env.IMAP_HOST || 'imap.purelymail.com', port: Number(env.IMAP_PORT) || 993, secure: env.IMAP_SECURE !== 'false' },
    maxDevicesPerMailbox: Number(env.MAX_DEVICES_PER_MAILBOX) || 10,
    purelymail: { apiKey: env.PURELYMAIL_API_KEY || '', baseUrl: env.PURELYMAIL_BASE_URL || 'https://purelymail.com/api/v0', suspendMode: env.MAIL_SUSPEND_MODE === 'password' ? 'password' : 'rename' },
    dns: { resolvers: list(env.DNS_RESOLVERS, '8.8.8.8,1.1.1.1,9.9.9.9,208.67.222.222') },
    renewals: { enabled: bool(env.RENEWALS_ENABLED, true), daysBefore: Number(env.RENEWAL_DAYS_BEFORE) || 30, intervalMs: Number(env.JOBS_INTERVAL_MS) || 6 * 3600 * 1000 },
    alerts: { webhookUrl: env.ALERT_WEBHOOK_URL || '' },
  };
}

/** Refuse de démarrer dans une configuration dangereuse (achats réels avec faux paiements, etc.). */
function assertSafe(cfg) {
  const errors = [];
  if (!cfg.namesilo.key) errors.push('NAMESILO_API_KEY manquante.');
  if (cfg.namesilo.mode === 'live' && cfg.payments.provider === 'demo') errors.push('NAMESILO_MODE=live avec PAYMENTS_PROVIDER=demo : des domaines réels seraient achetés sans vrai paiement.');
  if (cfg.auth.mode === 'demo' && cfg.nodeEnv === 'production') errors.push('AUTH_MODE=demo interdit avec NODE_ENV=production.');
  if (cfg.auth.mode === 'jwt' && cfg.auth.jwtSecret.length < 32) errors.push('JWT_SECRET (32 caractères minimum) requis avec AUTH_MODE=jwt.');
  if (cfg.payments.provider === 'paym' && (!cfg.payments.paym.clientId || !cfg.payments.paym.clientSecret)) errors.push('PAYM_CLIENT_ID et PAYM_CLIENT_SECRET requis avec PAYMENTS_PROVIDER=paym.');
  if (cfg.payments.stripe.secretKey && !/^(sk|rk)_(test|live)_/.test(cfg.payments.stripe.secretKey)) errors.push('STRIPE_SECRET_KEY invalide (attendu sk_test_… ou sk_live_…).');
  if (cfg.payments.stripe.secretKey && !cfg.payments.stripe.webhookSecret) errors.push('STRIPE_WEBHOOK_SECRET (whsec_…) requis avec STRIPE_SECRET_KEY : sans webhook signé, les paiements par carte ne seraient confirmés que par balayage.');
  if (cfg.nodeEnv === 'production' && /^sk_test_/.test(cfg.payments.stripe.secretKey) && cfg.namesilo.mode === 'live') errors.push('Clé Stripe de TEST avec NAMESILO_MODE=live : les achats réels seraient payés avec de fausses cartes.');
  if (cfg.nodeEnv === 'production' && cfg.purelymail.apiKey && !cfg.dataKey) errors.push('DATA_KEY (32 octets) requise en production : elle chiffre les mots de passe d’application des appareils.');
  if (cfg.mailer.provider === 'brevo' && !cfg.mailer.brevoKey) errors.push('BREVO_API_KEY requise avec MAILER=brevo.');
  if (cfg.nodeEnv === 'production' && cfg.mailer.provider === 'console') errors.push('MAILER=console en production : aucun e-mail (reçus, réinitialisation de mot de passe) ne partirait.');
  if (cfg.namesilo.nameservers.length === 1) errors.push('NAMESERVERS doit contenir au moins 2 serveurs (règle NameSilo).');
  return errors;
}

module.exports = { loadConfig, assertSafe, PLANS };
