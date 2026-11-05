/**
 * Tableau de bord administrateur : GET /api/admin/overview?days=30 (ADMIN_TOKEN).
 * Chiffres agrégés (clients, ventes, commandes, domaines, boîtes, notifications) + état du système + alertes de mise en production.
 * SQL portable (PostgreSQL / PGlite) ; les dates sont des textes ISO, donc comparables telles quelles.
 */
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const num = (v) => Number(v) || 0;
const money = (v) => Math.round(num(v) * 100) / 100;

function createOverview({ cfg, db, payments, mail, senders, startedAt = Date.now() }) {
  async function overview(daysRaw) {
    const days = Math.min(90, Math.max(7, Math.floor(Number(daysRaw)) || 30));
    const now = Date.now();
    const since = iso(now - days * DAY);
    const in30 = iso(now + 30 * DAY).slice(0, 10), in7 = iso(now + 7 * DAY).slice(0, 10), today = iso(now).slice(0, 10);

    const [users, usersNew, paidAll, paidPeriod, byKind, daily, byStatus, attention, subs, domainStatus, expiring, boxStatus, boxLogins, devices, devBoxes, signups, recent] = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM users'),
      db.get('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', since),
      db.get("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM orders WHERE status = 'paid' AND dry_run = 0"),
      db.get("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM orders WHERE status = 'paid' AND dry_run = 0 AND created_at >= ?", since),
      db.all("SELECT kind, COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM orders WHERE status = 'paid' AND dry_run = 0 AND created_at >= ? GROUP BY kind ORDER BY s DESC", since),
      db.all("SELECT SUBSTR(created_at,1,10) AS day, COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM orders WHERE status = 'paid' AND dry_run = 0 AND created_at >= ? GROUP BY SUBSTR(created_at,1,10) ORDER BY day", since),
      db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status'),
      db.all("SELECT o.id, o.reference, o.kind, o.amount, o.error, o.created_at, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.status = 'needs_attention' ORDER BY o.created_at DESC LIMIT 10"),
      db.all('SELECT plan, status, COUNT(*) AS n FROM subscriptions GROUP BY plan, status'),
      db.all("SELECT status, COUNT(*) AS n FROM domains WHERE status <> 'pending' GROUP BY status"),
      db.all("SELECT d.name, d.expires_at, d.auto_renew, u.email FROM domains d LEFT JOIN users u ON u.id = d.user_id WHERE d.status = 'active' AND d.external = 0 AND d.expires_at <> '' AND d.expires_at <= ? ORDER BY d.expires_at LIMIT 10", in30),
      db.all("SELECT provider_status AS status, COUNT(*) AS n FROM mailboxes WHERE provider_status <> 'creating' GROUP BY provider_status"),
      db.get('SELECT COUNT(*) AS n FROM mailboxes WHERE last_login >= ?', iso(now - 7 * DAY)),
      db.all('SELECT platform, COUNT(*) AS n FROM push_devices GROUP BY platform'),
      db.get('SELECT COUNT(DISTINCT mailbox_id) AS n FROM push_devices'),
      db.all('SELECT id, email, name, company, country, created_at FROM users ORDER BY created_at DESC LIMIT 8'),
      db.all('SELECT o.reference, o.kind, o.status, o.amount, o.created_at, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 8'),
    ]);

    const orderCount = Object.fromEntries(byStatus.map((r) => [r.status, num(r.n)]));
    const activeBoxes = boxStatus.filter((r) => r.status === 'active').reduce((s, r) => s + num(r.n), 0);
    const nonActiveBoxes = boxStatus.filter((r) => r.status !== 'active').reduce((s, r) => s + num(r.n), 0);
    const activeSubs = subs.filter((r) => r.status === 'active');
    const withinDays = expiring.filter((d) => d.expires_at <= in7).length;
    const system = {
      database: cfg.databaseUrl ? 'postgresql' : 'pglite', nodeEnv: cfg.nodeEnv, registrar: cfg.namesilo.mode, payments: payments.name, cards: !!payments.cards,
      mailer: cfg.mailer.provider, mailProvider: !!mail.providerEnabled, push: { ios: !!(senders && senders.ios), android: !!(senders && senders.android) },
      keepAlive: !!cfg.keepAlive.url, uptimeSeconds: Math.round((now - startedAt) / 1000), startedAt: iso(startedAt), memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    };
    const alerts = [];
    const add = (level, code, text) => alerts.push({ level, code, text });
    if (system.nodeEnv !== 'production') add('warn', 'not_production', `NODE_ENV = « ${system.nodeEnv} » (pas « production »).`);
    if (system.registrar !== 'live') add('warn', 'registrar_dry_run', `NameSilo en mode « ${system.registrar} » : les domaines ne sont pas réellement achetés.`);
    if (system.payments === 'demo') add('warn', 'payments_demo', 'Paiements en mode démonstration : aucun vrai paiement n’est encaissé.');
    if (system.mailer === 'console') add('warn', 'mailer_console', 'Aucun fournisseur d’e-mails transactionnels (Brevo) : les e-mails du site (réinitialisation, reçus) ne partent pas.');
    if (!system.mailProvider) add('error', 'mail_provider_off', 'Purelymail n’est pas configuré : les boîtes ne peuvent pas être créées.');
    if (!system.push.android && !system.push.ios) add('warn', 'push_off', 'Notifications push désactivées (ni FCM ni APNs).');
    if (!system.keepAlive) add('info', 'keepalive_off', 'Auto-ping désactivé : le serveur gratuit Render s’endort après 15 minutes sans visite.');
    if ((orderCount.needs_attention || 0) > 0) add('error', 'orders_need_attention', `${orderCount.needs_attention} commande(s) demandent une intervention.`);
    if (withinDays > 0) add('warn', 'domains_expiring', `${withinDays} domaine(s) expirent dans moins de 7 jours.`);
    if (nonActiveBoxes > 0) add('warn', 'boxes_not_active', `${nonActiveBoxes} boîte(s) mail pas encore actives chez Purelymail.`);

    const series = [];
    const byDay = new Map(daily.map((r) => [r.day, r]));
    for (let i = days - 1; i >= 0; i--) { const day = iso(now - i * DAY).slice(0, 10); const r = byDay.get(day); series.push({ day, amount: money(r && r.s), orders: num(r && r.n) }); }

    return {
      generatedAt: iso(now), days,
      customers: { total: num(users.n), new: num(usersNew.n) },
      revenue: { total: money(paidAll.s), totalOrders: num(paidAll.n), period: money(paidPeriod.s), periodOrders: num(paidPeriod.n), average: paidPeriod.n ? money(num(paidPeriod.s) / num(paidPeriod.n)) : 0, byKind: byKind.map((r) => ({ kind: r.kind, amount: money(r.s), orders: num(r.n) })), series },
      orders: { byStatus: orderCount, attention: attention.map((o) => ({ ...o, amount: money(o.amount) })), recent: recent.map((o) => ({ ...o, amount: money(o.amount) })) },
      subscriptions: { active: activeSubs.reduce((s, r) => s + num(r.n), 0), byPlan: subs.map((r) => ({ plan: r.plan, status: r.status, count: num(r.n) })) },
      domains: { byStatus: Object.fromEntries(domainStatus.map((r) => [r.status, num(r.n)])), expiring: expiring.map((d) => ({ name: d.name, expires: d.expires_at, autoRenew: !!d.auto_renew, email: d.email, daysLeft: Math.ceil((new Date(d.expires_at) - new Date(today)) / DAY) })) },
      mailboxes: { active: activeBoxes, notActive: nonActiveBoxes, loggedInLast7Days: num(boxLogins.n) },
      push: { devices: Object.fromEntries(devices.map((r) => [r.platform, num(r.n)])), mailboxes: num(devBoxes.n) },
      signups: signups.map((u) => ({ id: u.id, email: u.email, name: u.name, company: u.company, country: u.country, createdAt: u.created_at })),
      system, alerts,
    };
  }
  return { overview };
}

module.exports = { createOverview };
