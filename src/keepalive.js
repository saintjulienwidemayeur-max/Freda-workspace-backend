/**
 * Auto-ping : sur l'offre gratuite de Render, le serveur s'endort après 15 minutes SANS requête entrante (les notifications push ne peuvent alors plus
 * partir : les observateurs IMAP sont arrêtés). Le serveur appelle donc sa propre adresse publique toutes les 10 minutes : la requête passe par le routeur
 * de Render et compte comme du trafic. /api/health touche aussi la base (Supabase reste active).
 * L'offre payante (Starter) reste la vraie solution ; ceci est un palliatif. Désactivable : KEEP_ALIVE=false. Adresse : RENDER_EXTERNAL_URL (fournie par Render) ou KEEP_ALIVE_URL.
 */
const DEFAULT_MS = 10 * 60 * 1000;

function startKeepAlive({ url, intervalMs = DEFAULT_MS, fetchImpl = (...a) => fetch(...a), log = () => {} } = {}) {
  if (!url) return { enabled: false, tick: async () => false, stop() {} };
  const target = String(url).replace(/\/$/, '') + '/api/health';
  const tick = async () => {
    try {
      const res = await fetchImpl(target, { headers: { 'User-Agent': 'freda-keepalive' }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) { log('warn', 'keepalive_unhealthy', { status: res.status }); return false; }
      return true;
    } catch (e) { log('warn', 'keepalive_failed', { message: e.message }); return false; }
  };
  const timer = setInterval(tick, Math.max(60_000, Number(intervalMs) || DEFAULT_MS));
  timer.unref && timer.unref();
  return { enabled: true, tick, stop() { clearInterval(timer); } };
}

module.exports = { startKeepAlive, DEFAULT_MS };
