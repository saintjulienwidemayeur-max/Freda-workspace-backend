/** Configuration lue dans les variables d'environnement (voir .env.example). */
const list = (v, fallback) => String(v || fallback).split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

/** Offres Freda Mail (source de vérité des prix : le serveur, jamais le navigateur). Miroir de assets/js/config.js du frontend. */
const PLANS = {
  free: { id: 'free', name: 'Gratuit', monthly: 0, mailboxes: 2, storageGb: 1, free: true },   // 2 boîtes sur le domaine du client, sans abonnement ni paiement
  starter: { id: 'starter', name: 'Starter', monthly: 2.99, mailboxes: 1, storageGb: 2 },
  business: { id: 'business', name: 'Business', monthly: 9.99, mailboxes: 5, storageGb: 15 },
  enterprise: { id: 'enterprise', name: 'Enterprise', monthly: 30, mailboxes: Infinity, perBoxGb: 5 },
};

/** Valeurs multi-lignes en variable d'environnement : accepte le texte brut (avec \n littéraux) ou sa version base64. */
const pem = (v) => { const t = String(v || '').trim(); if (!t) return ''; const raw = t.includes('BEGIN') ? t : Buffer.from(t, 'base64').toString('utf8'); return raw.replace(/\\n/g, '\n'); };
const json = (v) => { const t = String(v || '').trim(); if (!t) return null; try { return JSON.parse(t.startsWith('{') ? t : Buffer.from(t, 'base64').toString('utf8')); } catch (e) { return { invalid: true }; } };

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
    keepAlive: { url: env.KEEP_ALIVE === 'false' ? '' : (env.KEEP_ALIVE_URL || env.RENDER_EXTERNAL_URL || ''), intervalMs: Number(env.KEEP_ALIVE_MS) || 10 * 60 * 1000 },   // auto-ping contre l'endormissement (Render gratuit)
    databaseUrl: env.DATABASE_URL || '',                           // PostgreSQL (Supabase : URI du « Session pooler »)
    databasePoolMax: Number(env.DATABASE_POOL_MAX) || 10,                // connexions simultanées maximum vers PostgreSQL (Supabase : rester sous la limite du pooler)
    databaseCa: String(env.DATABASE_CA || '').replace(/\\n/g, '\n'),   // certificat CA (PEM) pour vérifier le serveur ; vide = TLS sans vérification de l'autorité
    dbFile: env.DB_FILE || './data/pglite',                       // sans DATABASE_URL : PostgreSQL local (PGlite), dossier de données ou « :memory: »
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
      comparePercent: Number(env.PRICE_COMPARE_PERCENT ?? 0),   // pourcentage de « prix barré » affiché au-dessus du prix de vente (affichage seulement ; 0 = aucun)
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
      provider: env.PAYMENTS_PROVIDER || 'demo',                   // demo | paym | issuing (Freda Pay Issuing : MonCash / NatCash)
      stripe: {
        paymentMethodConfig: env.STRIPE_PAYMENT_METHOD_CONFIG || '',
        apiVersion: env.STRIPE_API_VERSION || '2026-09-30.endive',                 // version d'API figée (alignée sur Stripe.js « endive » ci-dessous)
        publishableKey: env.STRIPE_PUBLISHABLE_KEY || '',                          // pk_… (publique) : active Embedded Checkout (paiement dans une fenêtre du site)
        jsUrl: env.STRIPE_JS_URL || 'https://js.stripe.com/endive/stripe.js',
        uiMode: env.STRIPE_UI_MODE === 'hosted' || !env.STRIPE_PUBLISHABLE_KEY ? 'hosted' : 'embedded',
        secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '', baseUrl: env.STRIPE_BASE_URL || 'https://api.stripe.com' },
      issuing: { secretKey: env.FREDA_ISSUING_SECRET_KEY || '', webhookSecret: env.FREDA_ISSUING_WEBHOOK_SECRET || '', baseUrl: env.FREDA_ISSUING_BASE_URL || 'https://api.fredapay.com' },
      paym: { clientId: env.PAYM_CLIENT_ID || '', clientSecret: env.PAYM_CLIENT_SECRET || '', baseUrl: env.PAYM_BASE_URL || 'https://plopplop.solutionip.app' },
    },
    balance: { min: Number(env.BALANCE_MIN_TOPUP) || 5, max: Number(env.BALANCE_MAX_TOPUP) || 500 },   // recharge du solde, en USD
    dataKey: env.DATA_KEY || '',
    push: {
      preview: env.PUSH_PREVIEW !== 'false',                       // défaut : expéditeur, objet et début du message dans la notification (transitent par Apple/Google) ; PUSH_PREVIEW=false : « Nouveau message » seulement
      apns: { key: pem(env.APNS_KEY), keyId: env.APNS_KEY_ID || '', teamId: env.APNS_TEAM_ID || '', bundleId: env.APNS_BUNDLE_ID || '',
        baseUrl: env.APNS_BASE_URL || (env.APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com') },
      fcm: { serviceAccount: json(env.FCM_SERVICE_ACCOUNT), baseUrl: env.FCM_BASE_URL || 'https://fcm.googleapis.com' },
      sessionDays: Number(env.MAIL_SESSION_DAYS) || 30,
    },
    imap: { host: env.IMAP_HOST || 'imap.purelymail.com', port: Number(env.IMAP_PORT) || 993, secure: env.IMAP_SECURE !== 'false' },
    purelymail: { apiKey: env.PURELYMAIL_API_KEY || '', baseUrl: env.PURELYMAIL_BASE_URL || 'https://purelymail.com/api/v0', suspendMode: env.MAIL_SUSPEND_MODE === 'password' ? 'password' : 'rename' },
    dns: { resolvers: list(env.DNS_RESOLVERS, '8.8.8.8,1.1.1.1,9.9.9.9,208.67.222.222') },
    // Marque blanche DNS (facultatif) : domaine de VOTRE zone qui relaie les enregistrements DKIM/SPF/DMARC vers Purelymail (voir README). Vide = enregistrements Purelymail directs.
    mailDns: { brandDomain: String(env.MAIL_DNS_BRAND_DOMAIN || '').trim().toLowerCase().replace(/\.$/, '') },
    renewals: { enabled: bool(env.RENEWALS_ENABLED, true), daysBefore: Number(env.RENEWAL_DAYS_BEFORE) || 30, intervalMs: Number(env.JOBS_INTERVAL_MS) || 6 * 3600 * 1000 },
    alerts: { webhookUrl: env.ALERT_WEBHOOK_URL || '' },
  };
}

/** Rezime pou le journal de démarrage : SEULEMENT des booléens (jamais une valeur), pour savoir ce qui est configuré sans exposer un secret. */
function integrationSummary(cfg) {
  const s = cfg.payments.stripe;
  return {
    nodeEnv: cfg.nodeEnv, database: cfg.databaseUrl ? 'postgresql' : 'pglite',
    jwtSecret: !!cfg.auth.jwtSecret, dataKey: !!cfg.dataKey, adminToken: !!cfg.adminToken,
    namesilo: !!cfg.namesilo.key, namesiloMode: cfg.namesilo.mode, nameservers: cfg.namesilo.nameservers.length,
    paym: !!(cfg.payments.paym.clientId && cfg.payments.paym.clientSecret), issuingKey: !!cfg.payments.issuing.secretKey, issuingMode: /^sk_live_/.test(cfg.payments.issuing.secretKey) ? 'live' : cfg.payments.issuing.secretKey ? 'test' : null, issuingWebhook: !!cfg.payments.issuing.webhookSecret, paymentsProvider: cfg.payments.provider,
    stripeSecretKey: !!s.secretKey, stripeWebhookSecret: !!s.webhookSecret, stripePublishableKey: !!s.publishableKey, stripeUiMode: s.secretKey ? s.uiMode : null,
    brevo: !!cfg.mailer.brevoKey, mailer: cfg.mailer.provider, purelymail: !!cfg.purelymail.apiKey,
    google: !!(cfg.google.clientId && cfg.google.clientSecret), alertWebhook: !!cfg.alerts.webhookUrl,
    apns: !!cfg.push.apns.key, fcm: !!cfg.push.fcm.serviceAccount, appUrl: cfg.appUrl, apiUrl: cfg.apiUrl, allowedOrigins: cfg.allowedOrigins.length, keepAlive: !!cfg.keepAlive.url,
  };
}

/** Refuse de démarrer dans une configuration dangereuse (achats réels avec faux paiements, etc.). */
function assertSafe(cfg) {
  const errors = [];
  if (!cfg.namesilo.key) errors.push('NAMESILO_API_KEY manquante.');
  if (cfg.nodeEnv === 'production' && !cfg.databaseUrl) errors.push('DATABASE_URL (PostgreSQL / Supabase) requise en production.');
  if (cfg.databaseUrl && !/^postgres(ql)?:\/\//.test(cfg.databaseUrl)) errors.push('DATABASE_URL invalide (attendu postgresql://…).');
  if (cfg.namesilo.mode === 'live' && cfg.payments.provider === 'demo') errors.push('NAMESILO_MODE=live avec PAYMENTS_PROVIDER=demo : des domaines réels seraient achetés sans vrai paiement.');
  if (cfg.auth.mode === 'demo' && cfg.nodeEnv === 'production') errors.push('AUTH_MODE=demo interdit avec NODE_ENV=production.');
  if (cfg.auth.mode === 'jwt' && cfg.auth.jwtSecret.length < 32) errors.push('JWT_SECRET (32 caractères minimum) requis avec AUTH_MODE=jwt.');
  if (cfg.payments.provider === 'paym' && (!cfg.payments.paym.clientId || !cfg.payments.paym.clientSecret)) errors.push('PAYM_CLIENT_ID et PAYM_CLIENT_SECRET requis avec PAYMENTS_PROVIDER=paym.');
  const iss = cfg.payments.issuing;
  if (cfg.payments.provider === 'issuing' && !iss.secretKey) errors.push('FREDA_ISSUING_SECRET_KEY (sk_test_… ou sk_live_…) requise avec PAYMENTS_PROVIDER=issuing.');
  if (iss.secretKey && !/^sk_(test|live)_/.test(iss.secretKey)) errors.push('FREDA_ISSUING_SECRET_KEY invalide (attendu sk_test_… ou sk_live_…).');
  if (iss.webhookSecret && !/^whsec_/.test(iss.webhookSecret)) errors.push('FREDA_ISSUING_WEBHOOK_SECRET invalide (attendu whsec_…).');
  if (cfg.payments.provider === 'issuing' && /^sk_test_/.test(iss.secretKey) && cfg.namesilo.mode === 'live') errors.push('Clé Freda Pay Issuing de TEST avec NAMESILO_MODE=live : des domaines réels seraient achetés avec de faux paiements.');
  if (cfg.payments.stripe.secretKey && !/^(sk|rk)_(test|live)_/.test(cfg.payments.stripe.secretKey)) errors.push('STRIPE_SECRET_KEY invalide (attendu sk_test_… ou sk_live_…).');
  const pk = cfg.payments.stripe.publishableKey, sk = cfg.payments.stripe.secretKey;
  if (pk && !/^pk_(test|live)_/.test(pk)) errors.push('STRIPE_PUBLISHABLE_KEY invalide (attendu pk_test_… ou pk_live_…). Ne mettez JAMAIS la clé secrète ici : elle est envoyée au navigateur.');
  if (pk && sk && /^pk_live_/.test(pk) !== /^(sk|rk)_live_/.test(sk)) errors.push('STRIPE_PUBLISHABLE_KEY et STRIPE_SECRET_KEY ne sont pas du même mode (test / live).');
  if (!/^https:\/\/js\.stripe\.com\//.test(cfg.payments.stripe.jsUrl)) errors.push('STRIPE_JS_URL doit commencer par https://js.stripe.com/.');
  if (cfg.payments.stripe.secretKey && !cfg.payments.stripe.webhookSecret) errors.push('STRIPE_WEBHOOK_SECRET (whsec_…) requis avec STRIPE_SECRET_KEY : sans webhook signé, les paiements par carte ne seraient confirmés que par balayage.');
  if (cfg.nodeEnv === 'production' && /^sk_test_/.test(cfg.payments.stripe.secretKey) && cfg.namesilo.mode === 'live') errors.push('Clé Stripe de TEST avec NAMESILO_MODE=live : les achats réels seraient payés avec de fausses cartes.');
  if (cfg.nodeEnv === 'production' && cfg.namesilo.mode !== 'live') errors.push('NAMESILO_MODE=live requis en production : en dry-run, les clients paieraient des domaines qui ne sont jamais achetés chez NameSilo.');
  if (cfg.nodeEnv === 'production' && !cfg.dataKey) errors.push('DATA_KEY (32 octets) requise en production : elle chiffre les mots de passe de boîte choisis par les clients pendant l’exécution de leur commande.');
  if (cfg.nodeEnv === 'production' && cfg.payments.provider === 'demo') errors.push('PAYMENTS_PROVIDER=demo interdit en production : toute commande serait « payée » sans paiement (boîtes mail réelles gratuites). Utilisez paym (ou NODE_ENV=staging pour une instance d’essai).');
  const { apns, fcm } = cfg.push;
  if ((apns.key || apns.keyId || apns.teamId || apns.bundleId) && !(apns.key && apns.keyId && apns.teamId && apns.bundleId)) errors.push('APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID et APNS_BUNDLE_ID vont ensemble (notifications iPhone).');
  if (fcm.serviceAccount && (fcm.serviceAccount.invalid || !fcm.serviceAccount.private_key || !fcm.serviceAccount.client_email || !fcm.serviceAccount.project_id)) errors.push('FCM_SERVICE_ACCOUNT invalide (JSON de compte de service Firebase avec private_key, client_email, project_id).');
  if ((cfg.push.apns.key || cfg.push.fcm.serviceAccount) && !cfg.purelymail.apiKey) errors.push('Les notifications push exigent PURELYMAIL_API_KEY (identifiant de surveillance par boîte).');
  if (cfg.mailer.provider === 'brevo' && !cfg.mailer.brevoKey) errors.push('BREVO_API_KEY requise avec MAILER=brevo.');
  if (cfg.nodeEnv === 'production' && cfg.mailer.provider === 'console') errors.push('MAILER=console en production : aucun e-mail (reçus, réinitialisation de mot de passe) ne partirait.');
  if (cfg.mailDns.brandDomain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(cfg.mailDns.brandDomain)) errors.push('MAIL_DNS_BRAND_DOMAIN invalide (ex. fredaworkspace.com).');
  if (cfg.namesilo.nameservers.length === 1) errors.push('NAMESERVERS doit contenir au moins 2 serveurs (règle NameSilo).');
  return errors;
}

module.exports = { integrationSummary, loadConfig, assertSafe, PLANS };
