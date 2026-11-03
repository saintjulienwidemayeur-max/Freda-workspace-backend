/**
 * Vérification d'identifiants IMAP (AUTHENTICATE PLAIN, RFC 4616) sans dépendance : sert à vérifier « adresse pro + mot de passe » de la boîte
 * sur imap.purelymail.com quand l'application mobile se connecte (l'API Purelymail n'a aucun appel de vérification de mot de passe).
 * Retourne « ok » ou « denied » ; toute panne réseau / protocole est une exception (le serveur répond alors 503, jamais « mot de passe incorrect »).
 */
const net = require('net');
const tls = require('tls');

function imapLogin({ host, port, secure = true, user, pass, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    if (/[\0\r\n]/.test(user) || /[\0]/.test(pass)) return resolve('denied');
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = '', step = 'greeting', done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (e) { /* déjà fermée */ } err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('imap_timeout')), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('imap_closed')));
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) return finish(new Error('imap_overflow'));
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (step === 'greeting') {
          if (!/^\* OK/i.test(line)) return finish(new Error('imap_greeting'));
          step = 'plain'; sock.write('a1 AUTHENTICATE PLAIN\r\n');
        } else if (step === 'plain') {
          if (line.startsWith('+')) { step = 'result'; sock.write(Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64') + '\r\n'); }
          else if (/^a1 (NO|BAD)/i.test(line)) return finish(null, 'denied');
        } else if (step === 'result') {
          if (/^a1 OK/i.test(line)) { try { sock.write('a2 LOGOUT\r\n'); } catch (e) { /* ignoré */ } return finish(null, 'ok'); }
          if (/^a1 (NO|BAD)/i.test(line)) return finish(null, 'denied');
        }
      }
    });
  });
}

module.exports = { imapLogin };
