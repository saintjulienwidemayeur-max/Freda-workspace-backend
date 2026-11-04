/** GET /workspace : tout ce que l'espace client affiche, dans la forme attendue par assets/js/api.js (FW.workspace). */
function createWorkspace({ db, accounts, dns, mail, cfg }) {
  return async function buildWorkspace(userId) {
    const domains = await db.all('SELECT * FROM domains WHERE user_id = ? ORDER BY is_primary DESC, created_at', userId);
    const sub = await db.get('SELECT * FROM subscriptions WHERE user_id = ?', userId);
    const zones = {};
    for (const d of domains) zones[d.name] = await dns.list(userId, d.name);
    return {
      user: await accounts.me(userId),
      plan: sub ? { id: sub.plan, cycle: sub.cycle, renews: sub.renews_at, status: sub.status, cancelAtPeriodEnd: !!sub.cancel_at_period_end } : null,
      domains: domains.map((d) => ({ name: d.name, status: d.status, external: !!d.external, dnsMode: d.dns_mode, registered: d.registered_at, expires: d.expires_at, autoRenew: !!d.auto_renew, locked: !!d.locked, primary: !!d.is_primary, dryRun: !!d.dry_run })),
      dns: zones,
      dnsConfig: { nameservers: cfg ? cfg.namesilo.nameservers : [], nameserversAvailable: !!cfg && cfg.namesilo.nameservers.length >= 2, mailTemplate: dns.MAIL_TEMPLATE },   // sans serveurs de noms Freda réels, seul le mode « enregistrements » est proposé
      mailboxes: await mail.listBoxes(userId),
      aliases: await mail.listAliases(userId),
      paymentMethods: await accounts.listMethods(userId),
      invoices: (await db.all('SELECT * FROM invoices WHERE user_id = ? ORDER BY date DESC, id DESC', userId)).map((i) => ({ id: i.id, date: i.date, label: i.label, amount: i.amount, method: i.method, status: i.status })),
      activity: (await db.all('SELECT * FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 12', userId)).map((a) => ({ icon: a.icon, text: a.text, at: a.at })),
    };
  };
}
module.exports = { createWorkspace };
