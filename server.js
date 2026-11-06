const http = require('http');
const crypto = require('crypto');
const { loadConfig, assertSafe, integrationSummary } = require('./src/config');
const { openDb } = require('./src/db');
const { HttpError } = require('./src/errors');
const { createClient } = require('./src/namesilo');
const { createPriceBook } = require('./src/pricing');
const { createPayments } = require('./src/payments');
const { createMailboxAuthenticator, createAuthenticator } = require('./src/auth');
const { createMailer, templates } = require('./src/mailer');
const { createAlerts } = require('./src/alerts');
const { createAccounts } = require('./src/accounts');
const { createDomainCatalog } = require('./src/domains');
const { createDns } = require('./src/dns');
const { createMail } = require('./src/mail');
const { createVault } = require('./src/vault');
const { createMailTunnel } = require('./src/mail-tunnel');
const { createSubscription } = require('./src/subscription');
const { verifySignature } = require('./src/stripe');
const { createPush } = require('./src/push');
const { startKeepAlive } = require('./src/keepalive');
const { createPhotos } = require('./src/photos');
const { createSenders } = require('./src/push-senders');
const { createOrders } = require('./src/orders');
const { createJobs } = require('./src/jobs');
const { createWorkspace } = require('./src/workspace');
const { createDomainSettings } = require('./src/domain-settings');
const { createOverview } = require('./src/admin-overview');
const { createAdminTools } = require('./src/admin-tools');
const { createBalance } = require('./src/balance');
const { createPlans } = require('./src/plans');

const MAX_BODY = 32 * 1024;

function log(level, msg, extra = {}) { console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })); }

/** Limiteur en mémoire (par clé). Derrière un proxy, ajoutez aussi une limite à l'entrée (Cloudflare…). */
function createLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return arr.length <= max;
  };
}
/** Compte seulement les ÉCHECS (ex. mauvais jeton admin) : blocked(key) lit sans compter, fail(key) enregistre. */
function createFailureLimiter(max, windowMs) {
  const hits = new Map();
  const recent = (key) => { const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs); hits.set(key, arr); return arr; };
  return { blocked: (key) => recent(key).length >= max, fail: (key) => { recent(key).push(Date.now()); if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || Date.now() - v[v.length - 1] > windowMs) hits.delete(k); } };
}

function createApp(deps) {
  const cfg = deps.cfg;
  const logger = deps.log || log;
  const db = deps.db || openDb({ url: cfg.databaseUrl, file: cfg.dbFile, ca: cfg.databaseCa, poolMax: cfg.databasePoolMax });
  const registrar = deps.registrar || createClient(cfg.namesilo);
  const mailer = deps.mailer || createMailer(cfg, logger);
  const alert = deps.alert || createAlerts(cfg, logger);
  const payments = deps.payments || createPayments(cfg, logger, { db });
  const priceBook = createPriceBook({ registrar, cfg, db });
  /* Taux HTG pour 1 $ : modifiable depuis l'administration (app_settings.htg_rate) ; sinon HTG_RATE (132 par défaut). Les paiements MonCash / NatCash le lisent à chaque commande. */
  const DEFAULT_RATE = Number(process.env.HTG_RATE) || 132;
  const loadRate = async () => { try { const r = await db.get("SELECT value FROM app_settings WHERE key = 'htg_rate'"); const v = r ? Number(r.value) : DEFAULT_RATE; if (v >= 50 && v <= 1000) cfg.pricing.htgRate = v; } catch (_) { /* table absente : valeur par défaut */ } };
  db.ready.then(loadRate, () => {});
  setInterval(loadRate, 60_000).unref();   // plusieurs instances : le taux fixé dans l'administration se propage en moins d'une minute
  const catalog = createDomainCatalog({ cfg, registrar, priceBook, alert, log: logger });
  const accounts = createAccounts({ cfg, db, mailer, log: logger });
  const dns = createDns({ cfg, db, registrar, log: logger, resolve: deps.resolve });
  const vault = createVault(cfg);
  const mail = createMail({ cfg, db, log: logger, provider: deps.mailProvider, dns, vault, mailer });
  const balance = createBalance({ db });
  const plans = createPlans({ cfg, db });
  const orders = createOrders({ vault, cfg, db, payments, catalog, registrar, dns, mail, mailer, alert, log: logger, balance, plans });
  const subscription = createSubscription({ cfg, db, mailer });
  const jobs = createJobs({ cfg, db, orders, mailer, mail, log: logger, balance, plans });
  orders.hooks.afterTopup = (userId) => jobs.payForUser(userId);
  const workspace = createWorkspace({ db, accounts, dns, mail, cfg });
  const settings = createDomainSettings({ db, registrar, mailer, alert, log: logger, cfg });
  const authenticate = createAuthenticator(cfg, db);
  const authenticateMailbox = createMailboxAuthenticator(cfg, db);
  const pushSenders = deps.pushSenders || createSenders(cfg);
  const push = createPush({ cfg, db, log: logger, vault, mail, senders: pushSenders, debounceMs: deps.pushDebounceMs });
  const adminTools = createAdminTools({ cfg, db, mail, mailer, log: logger, templates });
  const overview = createOverview({ cfg, db, payments, mail, senders: pushSenders, balance });

  const photos = createPhotos({ db });

  /** decodeURIComponent sans 500 : un pourcentage mal formé est une erreur 400. */
  const dec = (v) => { try { return decodeURIComponent(v); } catch (e) { throw new HttpError(400, 'Adresse de requête invalide.', 'bad_request'); } };

  const L = { search: createLimiter(60, 60_000), auth: createLimiter(12, 60_000), buy: createLimiter(10, 60_000), write: createLimiter(120, 60_000), errors: createLimiter(20, 60_000) };
  const adminFails = createFailureLimiter(8, 10 * 60_000);   // 8 mauvais jetons admin par IP et par 10 minutes

  /* Table de routes : [méthode, motif, gestionnaire, options]. Les segments « :nom » ne contiennent pas de « / » (les noms de domaine contiennent des points). */
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), handler, opts });

  /* ----- public ----- */
  route('GET', '/api/health', async () => {
    try { await db.get('SELECT COUNT(*) AS n FROM app_migrations'); } catch (e) { logger('error', 'health_db_failed', { message: e.message }); throw new HttpError(503, 'Base de données inaccessible.', 'db_unavailable'); }   // 503 : Render ne route plus vers une instance sans base
    return { ok: true, database: true, registrar: cfg.namesilo.mode, payments: payments.name, mailer: cfg.mailer.provider, mailProvider: mail.providerEnabled, cards: !!payments.cards };
  });
  route('GET', '/api/plans', async () => ({ ...(await plans.publicView()), htgRate: cfg.pricing.htgRate }));   // prix des offres (modifiables par l'administrateur) : le site les affiche
  route('GET', '/api/domains/prices', async (c) => { limit(L.search, c.ip, 'Trop de recherches. Réessayez dans une minute.'); return catalog.prices(); });
  route('GET', '/api/domains/search', async (c) => { limit(L.search, c.ip, 'Trop de recherches. Réessayez dans une minute.'); return catalog.search(c.url.searchParams.get('q'), c.url.searchParams.get('part')); });
  route('POST', '/api/auth/signup', async (c) => { limit(L.auth, c.ip); return await accounts.signup(await c.body()); });
  route('POST', '/api/auth/login', async (c) => { limit(L.auth, c.ip); return await accounts.login(await c.body(), c.ip); });
  route('POST', '/api/auth/reset', async (c) => { limit(L.auth, c.ip); return await accounts.requestReset((await c.body()).email); });
  route('POST', '/api/auth/reset/confirm', async (c) => { limit(L.auth, c.ip); return await accounts.confirmReset(await c.body()); });
  route('POST', '/api/auth/verify', async (c) => { limit(L.auth, c.ip); return await accounts.verifyEmail((await c.body()).token); });
  route('POST', '/api/auth/logout', async () => ({ ok: true }));          // jetons sans état : le client oublie le jeton
  route('GET', '/api/auth/oauth/:provider', async (c, p) => ({ redirect: accounts.oauthStart(p[0], c.url.searchParams.get('next') || '') }));
  route('GET', '/api/auth/oauth/:provider/callback', async (c, p) => {
    try {
      const r = await accounts.oauthCallback(p[0], { code: c.url.searchParams.get('code') || '', state: c.url.searchParams.get('state') || '' });
      return { redirect: `${cfg.appUrl}/connexion.html#token=${r.token}${r.next ? '&next=' + encodeURIComponent(r.next) : ''}${r.isNew ? '&new=1' : ''}` };
    } catch (e) { log('warn', 'oauth_failed', { provider: p[0], code: e.code || 'oauth_failed', status: e.status }); return { redirect: `${cfg.appUrl}/connexion.html#error=${encodeURIComponent(e.code || 'oauth_failed')}` }; }
  });
  route('POST', '/api/client-errors', async (c) => {   // reçoit les erreurs JavaScript du frontend (ERROR_ENDPOINT de config.js)
    limit(L.errors, c.ip);
    const b = await c.body(4096);
    logger('warn', 'client_error', { message: String(b.message || '').slice(0, 300), page: String(b.page || '').slice(0, 120), source: String(b.source || '').slice(0, 160), line: b.line, stack: String(b.stack || '').slice(0, 800) });
    return { ok: true };
  });

  /* ----- compte ----- */
  const auth = { auth: true };
  route('POST', '/api/auth/verify/resend', async (c) => { limit(L.auth, c.user.id); return await accounts.resendVerification(c.user.id); }, auth);
  route('GET', '/api/me', async (c) => (await accounts.me(c.user.id)), auth);
  route('PATCH', '/api/me/company', async (c) => (await accounts.updateProfile(c.user.id, await c.body())), auth);
  route('PATCH', '/api/me', async (c) => (await accounts.updateProfile(c.user.id, await c.body())), auth);
  route('POST', '/api/me/password', async (c) => (await accounts.changePassword(c.user.id, await c.body())), auth);
  route('GET', '/api/workspace', async (c) => await workspace(c.user.id), auth);
  route('GET', '/api/payment-methods', async (c) => ({ methods: await accounts.listMethods(c.user.id) }), auth);
  route('POST', '/api/payment-methods', async (c) => ({ methods: await accounts.addMethod(c.user.id, await c.body()) }), auth);
  route('PATCH', '/api/payment-methods/:id', async (c, p) => ({ methods: await accounts.setDefaultMethod(c.user.id, p[0]) }), auth);
  route('DELETE', '/api/payment-methods/:id', async (c, p) => {
    const m = await db.get("SELECT stripe_pm FROM payment_methods WHERE id = ? AND user_id = ? AND stripe_pm <> ''", p[0], c.user.id);
    const methods = await accounts.removeMethod(c.user.id, p[0]);
    if (m && payments.stripe) await payments.stripe.detach(m.stripe_pm).catch(() => logger('warn', 'stripe_detach_failed', {}));   // la carte ne pourra plus être débitée
    return { methods };
  }, auth);

  /* ----- Stripe : webhook signé (corps BRUT requis pour la signature) ----- */
  route('POST', '/api/webhooks/stripe', async (c) => {
    if (!payments.stripe) throw new HttpError(404, 'Route introuvable.', 'not_found');
    const raw = await c.raw(256 * 1024);
    if (!verifySignature(raw, c.req.headers['stripe-signature'], cfg.payments.stripe.webhookSecret)) throw new HttpError(400, 'Signature invalide.', 'bad_signature');
    let event; try { event = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON invalide.'); }
    const obj = (event.data && event.data.object) || {};
    const ref = obj.client_reference_id || (obj.metadata && obj.metadata.reference);
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      if (ref) await orders.confirmByReference(ref);   // revérifie chez Stripe (un paiement différé encore « unpaid » reste en attente) ; une erreur -> 500 -> Stripe réessaie
    } else if (event.type === 'checkout.session.async_payment_failed') {
      if (ref) await orders.failByReference(ref, 'Le paiement a été refusé. Aucun montant n’a été débité : réessayez avec un autre moyen de paiement.');
    } else if (event.type === 'charge.dispute.created' || event.type === 'charge.refunded') {
      // litige ou remboursement chez Stripe : une recharge par carte est reprise du solde (sinon : achats gardés, argent perdu)
      const dispute = event.type === 'charge.dispute.created';
      const reference = (obj.metadata && obj.metadata.reference) || (obj.payment_intent ? await payments.stripe.referenceOf(String(obj.payment_intent)) : '');   // erreur -> 500 -> Stripe réessaie
      if (reference) await orders.reverseByReference(reference, dispute ? { kind: 'dispute' } : { kind: 'refund', refundedCents: Number(obj.amount_refunded) || 0, totalCents: Number(obj.amount) || 0 });
    }
    return { received: true };
  });
  /* ----- Freda Pay Issuing : webhook signé (HMAC-SHA256 du corps BRUT, en-tête X-Freda-Signature: sha256=…) ----- */
  route('POST', '/api/webhooks/issuing', async (c) => {
    const secret = cfg.payments.issuing.webhookSecret;
    if (cfg.payments.provider !== 'issuing' || !secret) throw new HttpError(404, 'Route introuvable.', 'not_found');
    const raw = await c.raw(256 * 1024);
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const got = String(c.req.headers['x-freda-signature'] || '').replace(/^sha256=/, '');
    if (!tokenEq(got, expected)) throw new HttpError(400, 'Signature invalide.', 'bad_signature');
    let event; try { event = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON invalide.'); }
    const ref = event.data && event.data.reference;
    if (event.event === 'payment.succeeded' && ref) await orders.confirmByReference(ref);   // revérifie chez Freda Pay Issuing (GET /v1/payments/:id) ; une erreur -> 500 -> nouvelle tentative
    else if (event.event === 'payment.failed' && ref) await orders.failByReference(ref, 'Le paiement n’a pas abouti. Aucun montant n’a été débité : réessayez.');
    return { received: true };
  });
  /* ----- solde prépayé (MonCash / NatCash) ----- */
  route('GET', '/api/balance', async (c) => {
    await plans.ready;
    const [amount, entries, auto, sub] = await Promise.all([balance.get(c.user.id), balance.entries(c.user.id), balance.autoPay(c.user.id), db.get("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','past_due','suspended')", c.user.id)]);
    const next = sub && !sub.cancel_at_period_end ? { plan: sub.plan, amount: orders.planAmount(sub.plan, sub.cycle), renews: sub.renews_at } : null;
    return { balance: amount, currency: 'USD', balanceHtg: Math.floor(amount * cfg.pricing.htgRate), htgRate: cfg.pricing.htgRate, autoPay: auto, min: cfg.balance.min, max: cfg.balance.max, next: next && { ...next, missing: Math.max(0, Math.round((next.amount - amount) * 100) / 100) }, entries };
  }, auth);
  route('PATCH', '/api/balance', async (c) => {
    limit(L.write, c.user.id);
    const b = await c.body();
    if (typeof b.autoPay !== 'boolean') throw new HttpError(400, 'Réglage invalide.', 'invalid_body');
    await balance.setAutoPay(c.user.id, b.autoPay);
    if (b.autoPay) await jobs.payForUser(c.user.id).catch(() => 0);   // rallumé : si une échéance attend et que le solde suffit, elle est payée tout de suite
    return { autoPay: b.autoPay };
  }, auth);
  route('GET', '/api/invoices', async (c) => ({ invoices: (await workspace(c.user.id)).invoices }), auth);

  /* ----- achats ----- */
  route('POST', '/api/checkout', async (c) => {
    limit(L.buy, c.user.id);
    await accounts.requireVerified(c.user.id);   // adresse email confirmée avant tout achat
    const body = await c.body();
    return await orders.create({ user: c.user, body, idempotencyKey: String(c.req.headers['idempotency-key'] || '').slice(0, 100) || null });
  }, auth);
  route('POST', '/api/subscription/cancel', async (c) => { limit(L.write, c.user.id); return await subscription.cancel(c.user.id); }, auth);
  route('POST', '/api/subscription/resume', async (c) => { limit(L.write, c.user.id); return await subscription.resume(c.user.id); }, auth);
  route('GET', '/api/orders/:id/payment', async (c, p) => { limit(L.write, c.user.id); return orders.paymentSession(c.user.id, p[0]); }, auth);
  route('GET', '/api/orders/:id', async (c, p) => (await orders.status(c.user.id, p[0])), auth);

  /* ----- domaines ----- */
  route('GET', '/api/domains', async (c) => ({ domains: (await workspace(c.user.id)).domains }), auth);
  route('POST', '/api/domains/connect', async (c) => { const b = await c.body(); return dns.connect(c.user.id, b.domain, b.mode); }, auth);
  route('PATCH', '/api/domains/:d', async (c, p) => (await settings.update(c.user.id, dec(p[0]), await c.body())), auth);
  route('POST', '/api/domains/:d/verify', async (c, p) => { limit(L.write, c.user.id); return await dns.verify(c.user.id, dec(p[0])); }, auth);
  route('POST', '/api/domains/:d/auth-code', async (c, p) => { limit(L.buy, c.user.id); return await settings.requestTransferCode(c.user.id, dec(p[0])); }, auth);

  /* ----- DNS ----- */
  route('GET', '/api/domains/:d/dns', async (c, p) => (await dns.list(c.user.id, dec(p[0]))), auth);
  route('POST', '/api/domains/:d/dns', async (c, p) => { limit(L.write, c.user.id); return await dns.save(c.user.id, dec(p[0]), await c.body()); }, auth);
  route('PATCH', '/api/domains/:d/dns/:id', async (c, p) => { limit(L.write, c.user.id); return await dns.save(c.user.id, dec(p[0]), { ...(await c.body()), id: p[1] }); }, auth);
  route('DELETE', '/api/domains/:d/dns/:id', async (c, p) => (await dns.remove(c.user.id, dec(p[0]), p[1])), auth);
  route('POST', '/api/domains/:d/dns/autofix', async (c, p) => { limit(L.write, c.user.id); return await dns.autofix(c.user.id, dec(p[0])); }, auth);
  route('GET', '/api/domains/:d/dns/check', async (c, p) => (await dns.propagation(c.user.id, dec(p[0]))), auth);

  /* ----- Freda Mail ----- */
  route('GET', '/api/mailboxes', async (c) => ({ mailboxes: await mail.listBoxes(c.user.id), aliases: await mail.listAliases(c.user.id) }), auth);
  route('POST', '/api/mailboxes', async (c) => { limit(L.write, c.user.id); await accounts.requireVerified(c.user.id); return await mail.createBox(c.user.id, await c.body()); }, auth);
  route('GET', '/api/domains/:d/mail-ownership', async (c, p) => (await mail.ownership(c.user.id, dec(p[0]))), auth);
  route('GET', '/api/mail/config', async () => mail.connection(), auth);
  /* Connexion de l'application mobile : adresse pro + mot de passe de la boîte (public, limité par IP et par adresse) */
  route('POST', '/api/mail/login', async (c) => { limit(L.auth, c.ip); return await mail.appLogin(await c.body(2048)); });
  /* Notifications push : session de BOÎTE (jeton renvoyé par /api/mail/login), jamais de session de compte */
  const mbx = { mailbox: true };
  route('GET', '/api/mail/push', async (c) => ({ ios: push.enabled('ios'), android: push.enabled('android'), web: push.enabled('web'), vapidPublicKey: push.enabled('web') ? cfg.push.web.publicKey : '', devices: (await db.get('SELECT COUNT(*) AS n FROM push_devices WHERE mailbox_id = ?', c.mailbox.id)).n }), mbx);
  route('POST', '/api/mail/push', async (c) => { limit(L.write, c.mailbox.id); return await push.register(c.mailbox, await c.body(4096)); }, mbx);
  route('DELETE', '/api/mail/push', async (c) => { limit(L.write, c.mailbox.id); return await push.unregister(c.mailbox, c.url.searchParams.get('token') || (await c.body(4096)).token); }, mbx);
  /* Photos de profil : visibles seulement par les utilisateurs connectés de l'application (session de boîte) */
  route('PUT', '/api/mail/photo', async (c) => { limit(L.write, c.mailbox.id); return await photos.save(c.mailbox, await c.raw(photos.MAX_BYTES + 1024)); }, mbx);
  route('DELETE', '/api/mail/photo', async (c) => { limit(L.write, c.mailbox.id); return await photos.remove(c.mailbox); }, mbx);
  route('POST', '/api/mail/photos', async (c) => { limit(L.search, c.mailbox.id); return await photos.lookup((await c.body(8192)).addresses); }, mbx);
  route('GET', '/api/mail/photo/:address', async (c, p) => {
    limit(L.search, c.mailbox.id);
    const ph = await photos.get(dec(p[0]));
    if (!ph) throw new HttpError(404, 'Pas de photo.', 'no_photo');
    return { binary: { type: ph.type, data: ph.data, etag: '"' + ph.version + '"' } };
  }, mbx);
  route('POST', '/api/mailboxes/:id/password', async (c, p) => { limit(L.auth, c.user.id); return await mail.changePassword(c.user.id, p[0], (await c.body(2048)).password); }, auth);
  route('DELETE', '/api/mailboxes/:id', async (c, p) => (await mail.removeBox(c.user.id, p[0])), auth);
  route('POST', '/api/aliases', async (c) => (await mail.addAlias(c.user.id, await c.body())), auth);
  route('DELETE', '/api/aliases/:id', async (c, p) => (await mail.removeAlias(c.user.id, p[0])), auth);

  /* ----- administration (ADMIN_TOKEN) ----- */
  const admin = { admin: true };
  route('POST', '/api/admin/jobs/run', async () => jobs.run(), admin);
  route('GET', '/api/admin/brand-dns', async () => dns.brandStatus(), admin);   // marque blanche DNS : vos relais existent-ils ? (vue détaillée)
  route('GET', '/api/admin/overview', async (c) => overview.overview(c.url.searchParams.get('days')), admin);   // tableau de bord administrateur
  /* offrir une offre Freda Mail (sans paiement) et annonces e-mail */
  route('GET', '/api/admin/customers', async (c) => adminTools.customers(c.url.searchParams.get('q')), admin);
  route('GET', '/api/admin/grants', async () => ({ ...(await adminTools.grants()), plans: adminTools.plansView(), maxMonths: adminTools.maxMonths }), admin);
  route('POST', '/api/admin/grants', async (c) => adminTools.grant(await c.body()), admin);
  route('GET', '/api/admin/announcements', async () => adminTools.announcements(), admin);
  route('GET', '/api/admin/announcements/audience', async (c) => adminTools.audienceCount(c.url.searchParams.get('audience')), admin);
  route('POST', '/api/admin/announcements/test', async (c) => adminTools.test(await c.body(64 * 1024)), admin);
  route('POST', '/api/admin/announcements', async (c) => adminTools.create(await c.body(64 * 1024)), admin);
  route('POST', '/api/admin/announcements/:id/resume', async (c, p) => adminTools.resume(p[0], await c.body()), admin);
  route('GET', '/api/admin/domain-prices', async () => catalog.priceTable(), admin);
  /* prix mensuels des offres (Starter, Business, Enterprise) */
  route('GET', '/api/admin/plans', async () => plans.view(), admin);
  route('PUT', '/api/admin/plans', async (c) => {
    try { await plans.save(await c.body()); } catch (e) { if (e.code === 'invalid_plans') throw new HttpError(400, e.message, 'invalid_plans'); throw e; }
    logger('info', 'plans_changed', { prices: Object.fromEntries((await plans.view()).plans.map((p) => [p.id, p.monthly])) });
    return await plans.view();
  }, admin);
  /* marge sur les noms de domaine : lecture (avec aperçu ?markupPercent=&minMarkup=, rien n'est enregistré) et modification */
  route('GET', '/api/admin/pricing', async (c) => {
    const q = c.url.searchParams;
    return await catalog.priceTable({ markupPercent: q.has('markupPercent') ? q.get('markupPercent') : undefined, minMarkup: q.has('minMarkup') ? q.get('minMarkup') : undefined });
  }, admin);
  route('PUT', '/api/admin/pricing', async (c) => {
    const b = await c.body();
    try { await priceBook.save(b.reset === true ? { reset: true } : { markupPercent: b.markupPercent, minMarkup: b.minMarkup }); }
    catch (e) { if (e.code === 'invalid_pricing') throw new HttpError(400, e.message, 'invalid_pricing'); throw e; }
    const now = await priceBook.settings();
    logger('info', 'pricing_changed', { markupPercent: now.markupPercent, minMarkup: now.minMarkup, custom: now.custom });
    return await catalog.priceTable();
  }, admin);
  /* taux de change HTG pour 1 $ (affichage et montants MonCash / NatCash) */
  route('GET', '/api/admin/rate', async () => ({ htgRate: cfg.pricing.htgRate, defaultRate: DEFAULT_RATE }), admin);
  route('PUT', '/api/admin/rate', async (c) => {
    const b = await c.body();
    const v = b.reset === true ? DEFAULT_RATE : Number(b.htgRate);
    if (!(v >= 50 && v <= 1000)) throw new HttpError(400, 'Le taux doit être compris entre 50 et 1000 HTG pour 1 $.', 'invalid_rate');
    const now = new Date().toISOString();
    if (b.reset === true) await db.run("DELETE FROM app_settings WHERE key = 'htg_rate'");
    else await db.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', 'htg_rate', String(v), now);
    cfg.pricing.htgRate = v;
    logger('info', 'rate_changed', { htgRate: v });
    return { htgRate: v };
  }, admin);
  route('GET', '/api/admin/orders', async (c) => ({ orders: await db.all('SELECT id, reference, user_id, kind, status, amount, error, created_at FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 100', c.url.searchParams.get('status') || 'needs_attention') }), admin);

  function limit(limiter, key, msg = 'Trop de tentatives. Réessayez dans une minute.') { if (!limiter(key)) throw new HttpError(429, msg, 'rate_limited'); }
  const tokenEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function readRaw(req, max) {
    let size = 0; const chunks = [];
    for await (const ch of req) { size += ch.length; if (size > max) throw new HttpError(413, 'Requête trop volumineuse.'); chunks.push(ch); }
    return Buffer.concat(chunks);
  }

  async function readJson(req, max = MAX_BODY) {
    let size = 0; const chunks = [];
    for await (const ch of req) { size += ch.length; if (size > max) throw new HttpError(413, 'Requête trop volumineuse.'); chunks.push(ch); }
    if (!chunks.length) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; } catch (e) { throw new HttpError(400, 'JSON invalide.'); }
  }

  const rejectedOrigins = new Set();
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = {};
    if (origin && cfg.allowedOrigins.includes(origin)) Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
    if (origin && !cors['Access-Control-Allow-Origin'] && !rejectedOrigins.has(origin) && rejectedOrigins.size < 20) { rejectedOrigins.add(origin); log('warn', 'cors_origin_rejected', { origin, hint: 'ajouter cette origine à ALLOWED_ORIGINS' }); }
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors, ...headers }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') return send(204, {}, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key', 'Access-Control-Max-Age': '600' });
    // IP du client : derrière N proxys de confiance (Render : 1), on prend la N-ième entrée en partant de la DROITE de X-Forwarded-For.
    // La première entrée est fournie par le client et ne doit jamais servir de clé de limitation (contournement par en-tête falsifié).
    const hops = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1));
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const ip = (hops > 0 && xff.length ? xff[Math.max(0, xff.length - hops)] : '') || req.socket.remoteAddress || '';
    const url = new URL(req.url, 'http://x');
    try {
      let matched = null, params = null;
      for (const r of routes) { if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (m) { matched = r; params = m.slice(1); break; } }
      if (!matched) throw new HttpError(404, 'Route introuvable.', 'not_found');
      const ctx = { req, url, ip, body: async (max) => (await readJson(req, max)), raw: async (max) => (await readRaw(req, max)) };
      if (matched.opts.admin) {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (adminFails.blocked(ip)) throw new HttpError(429, 'Trop de tentatives. Réessayez plus tard.', 'rate_limited');
        if (!cfg.adminToken || !m || !tokenEq(m[1], cfg.adminToken)) { adminFails.fail(ip); throw new HttpError(401, 'Accès administrateur requis.', 'unauthorized'); }
      }
      if (matched.opts.auth) ctx.user = await authenticate(req);
      if (matched.opts.mailbox) ctx.mailbox = await authenticateMailbox(req);
      const out = await matched.handler(ctx, params);
      if (out && out.binary) {
        const b = out.binary;
        if (req.headers['if-none-match'] === b.etag) { res.writeHead(304, { ETag: b.etag, 'Cache-Control': 'private, max-age=60', ...cors }); return res.end(); }
        res.writeHead(200, { 'Content-Type': b.type, 'Content-Length': b.data.length, ETag: b.etag, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff', ...cors });
        return res.end(b.data);
      }
      if (out && out.redirect) { res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store', ...cors }); return res.end(); }
      return send(200, out);
    } catch (e) {
      // violation de contrainte PostgreSQL (doublon, clé étrangère) : conflit métier, jamais une erreur interne
      if (!e.status && e.code === '23505') { e.status = 409; e.message = 'Cet élément existe déjà.'; e.code = 'duplicate'; }
      else if (!e.status && e.code === '23503') { e.status = 409; e.message = 'Cet élément est lié à d’autres données.'; e.code = 'conflict'; }
      const status = e.status || 500;
      if (status >= 500) logger('error', 'request_failed', { path: url.pathname, name: e.name, code: e.code, message: status === 500 ? e.message : undefined });
      send(status, { message: status >= 500 && !(e instanceof HttpError) ? 'Erreur interne.' : e.message, code: e.code, ...(status < 500 && e.details ? { details: e.details } : {}) });
    }
  });
  server.app = { db, registrar, mailer, orders, jobs, dns, mail, accounts, alert, push };
  // Version web (PWA) : tunnel WebSocket vers IMAP / SMTP (voir src/mail-tunnel.js)
  const tunnel = createMailTunnel({ cfg, authenticateMailbox, log: logger });
  server.on('upgrade', (req, socket, head) => {
    const hops = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1));
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const ip = (hops > 0 && xff.length ? xff[Math.max(0, xff.length - hops)] : '') || req.socket.remoteAddress || '';
    if (!tunnel.handleUpgrade(req, socket, head, ip)) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); }
  });
  server.on('close', () => tunnel.close());
  return server;
}

if (require.main === module) {
  const cfg = loadConfig();
  const problems = assertSafe(cfg);
  if (problems.length) { problems.forEach((p) => log('fatal', p)); process.exit(1); }
  const app = createApp({ cfg });
  let keepAlive = { stop() {} };
  app.app.db.ready.then(() => {
    app.app.jobs.start(); app.app.jobs.startSweeper();
    app.app.push.start().catch((e) => log('error', 'push_start_failed', { message: e.message }));
    keepAlive = startKeepAlive({ url: cfg.keepAlive.url, intervalMs: cfg.keepAlive.intervalMs, log });
    app.listen(cfg.port, () => log('info', 'api_started', { port: cfg.port, registrar: cfg.namesilo.mode, payments: cfg.payments.provider, mailer: cfg.mailer.provider, database: cfg.databaseUrl ? 'postgresql' : 'pglite', integrations: integrationSummary(cfg) }));
  }, (e) => { log('fatal', 'Base de données inaccessible ou migration échouée : ' + e.message); process.exit(1); });
  const stop = () => { keepAlive.stop(); app.app.jobs.stop(); app.app.push.stop(); app.close(() => { app.app.db.close().finally(() => process.exit(0)); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

module.exports = { createApp };
