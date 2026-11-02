/** Alertes opérationnelles (commande à traiter à la main, remboursement échoué, solde NameSilo bas…). Journal + webhook compatible Slack/Discord. */
function createAlerts(cfg, log) {
  const recent = new Map();
  return async function alert(level, message, data = {}) {
    log(level, 'ALERT ' + message, data);
    if (!cfg.alerts.webhookUrl) return;
    const key = message + JSON.stringify(data);
    if (recent.has(key) && Date.now() - recent.get(key) < 10 * 60 * 1000) return;   // anti-spam : 10 min
    recent.set(key, Date.now());
    try {
      await fetch(cfg.alerts.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `[Freda ${level}] ${message} ${JSON.stringify(data)}`, content: `[Freda ${level}] ${message}` }), signal: AbortSignal.timeout(8000) });
    } catch (e) { log('warn', 'alert_delivery_failed'); }
  };
}
module.exports = { createAlerts };
