/**
 * Passerelle WebSocket -> IMAP / SMTP pour la version web (PWA) de Freda Mail.
 *
 * Un navigateur ne peut pas ouvrir de connexion TCP. L'application web parle donc IMAP/SMTP à travers un tunnel WebSocket :
 *   wss://…/api/mail/tunnel?target=imap|smtp   avec les sous-protocoles « freda.v1 » puis le jeton de session de boîte
 * Les trames binaires transportent les octets IMAP/SMTP en clair (dans wss) ; la passerelle ouvre la connexion TLS vers le serveur de
 * messagerie (993 / 465). Le mot de passe de la boîte traverse la passerelle (dans la commande LOGIN / AUTH) sans jamais être lu ni stocké.
 *
 * Garde-fous : jeton de boîte valide (même contrôle que l'application mobile), origine autorisée, destinations FIXES (impossible de viser
 * un autre serveur : pas de proxy ouvert), limites par IP et par boîte, durée et inactivité bornées, volume borné.
 */
const net = require('net');
const tls = require('tls');
const { WebSocketServer } = require('ws');

function createMailTunnel({ cfg, authenticateMailbox, log, limits = {} }) {
  const maxPerIp = limits.maxPerIp || 6, maxPerBox = limits.maxPerBox || 4;
  const connectMs = limits.connectMs || 15_000;
  const idleMs = limits.idleMs || 5 * 60_000, maxMs = limits.maxMs || 60 * 60_000, maxBytes = limits.maxBytes || 200 * 1024 * 1024;
  const targets = {
    imap: { host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure },
    smtp: { host: cfg.tunnel.smtpHost, port: cfg.tunnel.smtpPort, secure: cfg.tunnel.smtpSecure },
  };
  const perIp = new Map(), perBox = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const dec = (m, k) => { const n = (m.get(k) || 1) - 1; if (n <= 0) m.delete(k); else m.set(k, n); };
  // Le jeton voyage dans l'en-tête Sec-WebSocket-Protocol (« freda.v1, <jeton> ») et non dans l'URL : une adresse finit dans des journaux, pas un en-tête.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has('freda.v1') ? 'freda.v1' : false) });
  const tokenOf = (req) => { const p = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim()).filter(Boolean); return p[0] === 'freda.v1' && p[1] ? p[1] : ''; };

  const refuse = (socket, code, msg) => { try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (e) { /* déjà fermé */ } socket.destroy(); };

  /** Gestionnaire de l'événement « upgrade » du serveur HTTP. Retourne false si la requête n'est pas pour le tunnel. */
  function handleUpgrade(req, socket, head, clientIp) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/mail/tunnel') return false;
    const origin = req.headers.origin;
    if (!origin || !cfg.allowedOrigins.includes(origin)) { log('warn', 'tunnel_origin_rejected', { origin: origin || '' }); refuse(socket, 403, 'Forbidden'); return true; }
    const target = targets[url.searchParams.get('target')];
    if (!target) { refuse(socket, 400, 'Bad Request'); return true; }
    if ((perIp.get(clientIp) || 0) >= maxPerIp) { refuse(socket, 429, 'Too Many Requests'); return true; }
    (async () => {
      let box;
      const t0 = Date.now();
      try { box = await authenticateMailbox({ headers: { authorization: 'Bearer ' + tokenOf(req) } }); }
      catch (e) { refuse(socket, 401, 'Unauthorized'); return; }
      if ((perBox.get(box.id) || 0) >= maxPerBox) { refuse(socket, 429, 'Too Many Requests'); return; }
      const authMs = Date.now() - t0;
      wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, target, box, clientIp, url.searchParams.get('target'), authMs));
    })().catch(() => refuse(socket, 500, 'Internal Server Error'));
    return true;
  }

  function bridge(ws, target, box, clientIp, kind, authMs = 0) {
    inc(perIp, clientIp); inc(perBox, box.id);
    // Diagnostic : à quelle étape ça bloque ? (durées en ms depuis l'ouverture du tunnel ; aucune donnée de message n'est journalisée)
    const t0 = Date.now(), since = () => Date.now() - t0;
    const st = { up: 0, down: 0, upMsgs: 0, downMsgs: 0, connectMs: -1, firstByteMs: -1, firstClientMs: -1, lastClientMs: -1, lastUpstreamMs: -1, upstreamErr: '' };
    let up, closed = false, bytes = 0, idle, hard, connectTimer;
    const done = (why) => {
      if (closed) return; closed = true; clearTimeout(idle); clearTimeout(hard); clearTimeout(connectTimer);
      dec(perIp, clientIp); dec(perBox, box.id);
      try { up && up.destroy(); } catch (e) { /* déjà fermée */ }
      try { ws.close(1000, why || ''); } catch (e) { /* déjà fermée */ }
      log('info', 'tunnel_close', { kind, mailbox: box.address, why: why || '', ms: since(), authMs, connectMs: st.connectMs, firstByteMs: st.firstByteMs, bytesToUpstream: st.up, bytesFromUpstream: st.down, msgsToUpstream: st.upMsgs, msgsFromUpstream: st.downMsgs, lastClientMs: st.lastClientMs, lastUpstreamMs: st.lastUpstreamMs, upstreamErr: st.upstreamErr });
    };
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => done('idle'), idleMs); idle.unref && idle.unref(); };
    hard = setTimeout(() => done('max_duration'), maxMs); hard.unref && hard.unref();
    touch();
    // écriture avant connexion : Node met les octets en file d'attente jusqu'à l'ouverture (TLS compris)
    up = target.secure ? tls.connect({ host: target.host, port: target.port, servername: target.host }) : net.connect({ host: target.host, port: target.port });
    up.setNoDelay(true);   // petites commandes SMTP/IMAP : pas d'attente de Nagle
    // connexion amont (TCP + TLS) trop longue : on le dit clairement au lieu de laisser le client attendre son délai
    connectTimer = setTimeout(() => done('upstream_connect_timeout'), connectMs); connectTimer.unref && connectTimer.unref();
    up.once(target.secure ? 'secureConnect' : 'connect', () => { clearTimeout(connectTimer); st.connectMs = since(); });
    up.on('data', (d) => { bytes += d.length; st.down += d.length; st.downMsgs++; st.lastUpstreamMs = since(); if (st.firstByteMs < 0) st.firstByteMs = since(); if (bytes > maxBytes) return done('quota'); touch(); if (ws.readyState === 1) ws.send(d, { binary: true }); });
    up.on('error', (e) => { st.upstreamErr = e.code || e.message || ''; log('warn', 'tunnel_upstream_error', { kind, code: e.code || '' }); done('upstream_error'); });
    up.on('close', () => done('upstream_closed'));
    ws.on('message', (data, isBinary) => {
      const b = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      bytes += b.length; st.up += b.length; st.upMsgs++; st.lastClientMs = since(); if (st.firstClientMs < 0) st.firstClientMs = since();
      if (bytes > maxBytes) return done('quota'); touch();
      up.write(b);
    });
    ws.on('close', (code) => done('client_closed' + (code && code !== 1000 ? ':' + code : '')));
    ws.on('error', (e) => done('client_error' + (e && e.code ? ':' + e.code : '')));
    log('info', 'tunnel_open', { kind, mailbox: box.address, authMs });
  }

  return { handleUpgrade, close() { wss.close(); }, stats: () => ({ ips: perIp.size, boxes: perBox.size }) };
}

module.exports = { createMailTunnel };
