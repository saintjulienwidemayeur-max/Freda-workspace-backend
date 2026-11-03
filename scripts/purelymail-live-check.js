#!/usr/bin/env node
/**
 * Test RÉEL de Purelymail avec une boîte JETABLE (créée puis supprimée) : vérifie ce qui n'a pu être testé que contre des faux serveurs.
 *
 *   PURELYMAIL_API_KEY=… PURELYMAIL_TEST_DOMAIN=un-domaine-deja-ajoute.com node scripts/purelymail-live-check.js --yes [--deliver]
 *
 * Prérequis : le domaine de test est déjà ajouté et vérifié dans votre compte Purelymail (MX/SPF/… en place pour --deliver).
 * Sécurité : ne touche QUE la boîte qu'il crée (fredatest-xxxxxxxx@domaine) ; nettoyage garanti même en cas d'échec ; aucun mot de passe affiché ;
 * refuse de tourner sans --yes. Sortie : PASS / FAIL par vérification, code de sortie 1 au moindre échec.
 * Vérifie, avec NOTRE code (adaptateur + client IMAP) contre le vrai serveur :
 *   1. la clé et le domaine ; 2. createUser ; 3. connexion IMAP AUTHENTICATE PLAIN (bon / mauvais mot de passe) ;
 *   4. suspension = renommage : l'ancienne adresse est refusée, le mot de passe n'a pas changé ;
 *   5. règle de routage créée puis retrouvée (listRoutingRules) ; 6. réactivation : mêmes identifiants refonctionnent ;
 *   7. changement de mot de passe ; 8. (--deliver) le courrier envoyé à l'ancienne adresse arrive bien dans la boîte renommée ;
 *   9. notifications push : createAppPassword (identifiant de surveillance) accepté en IMAP, (--deliver) l'observateur IMAP IDLE détecte un nouveau message,
 *      deleteAppPassword révoque l'identifiant.
 */
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { loadConfig } = require('../src/config');
const { createPurelymail } = require('../src/mail');
const { imapLogin } = require('../src/imap');
const { watchMailbox } = require('../src/push');

const args = process.argv.slice(2);
const hex = (n) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Session texte ligne à ligne (IMAP / SMTP) avec attente d'un motif. */
function open({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = ''; const waiters = [];
    const pump = () => { for (let i = 0; i < waiters.length; i++) { const m = waiters[i].re.exec(buf); if (m) { const text = buf.slice(0, m.index + m[0].length); buf = buf.slice(m.index + m[0].length); waiters.splice(i, 1)[0].res(text); return pump(); } } };
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; pump(); });
    sock.on('error', (e) => { reject(e); waiters.splice(0).forEach((w) => w.rej(e)); });
    const ready = () => resolve({
      write: (s) => sock.write(s),
      expect: (re, ms = 15000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('délai dépassé en attendant ' + re)), ms); waiters.push({ re, res: (x) => { clearTimeout(t); res(x); }, rej }); pump(); }),
      close: () => sock.destroy(),
    });
    sock.once(secure ? 'secureConnect' : 'connect', ready);
  });
}
const plain = (u, p) => Buffer.from(`\0${u}\0${p}`).toString('base64');

async function imapInboxHas(cfg, { user, pass, subject }) {
  const s = await open(cfg.imap);
  try {
    await s.expect(/^\* OK[^\r\n]*\r\n/m);
    s.write('a1 AUTHENTICATE PLAIN\r\n'); await s.expect(/^\+[^\r\n]*\r\n/m);
    s.write(plain(user, pass) + '\r\n');
    if (!/^a1 OK/m.test(await s.expect(/^a1 (OK|NO|BAD)[^\r\n]*\r\n/m))) throw new Error('connexion IMAP refusée');
    s.write('a2 SELECT INBOX\r\n'); await s.expect(/^a2 (OK|NO|BAD)[^\r\n]*\r\n/m);
    s.write(`a3 SEARCH SUBJECT "${subject}"\r\n`);
    const r = await s.expect(/^a3 (OK|NO|BAD)[^\r\n]*\r\n/m);
    const hit = /\* SEARCH ([\d ]+)\r?\n/.exec(r);
    s.write('a4 LOGOUT\r\n');
    return !!hit && hit[1].trim().length > 0;
  } finally { s.close(); }
}

async function smtpSend(smtp, { user, pass, from, to, subject }) {
  const s = await open(smtp);
  try {
    await s.expect(/^220 [^\r\n]*\r\n/m);
    s.write('EHLO fredatest.local\r\n'); await s.expect(/^250 [^\r\n]*\r\n/m);
    s.write('AUTH PLAIN ' + plain(user, pass) + '\r\n');
    if (!/^235/m.test(await s.expect(/^(235|5\d\d) [^\r\n]*\r\n/m))) throw new Error('authentification SMTP refusée');
    s.write(`MAIL FROM:<${from}>\r\n`); await s.expect(/^250 [^\r\n]*\r\n/m);
    s.write(`RCPT TO:<${to}>\r\n`); if (!/^250/m.test(await s.expect(/^(250|[45]\d\d) [^\r\n]*\r\n/m))) throw new Error('destinataire refusé');
    s.write('DATA\r\n'); await s.expect(/^354 [^\r\n]*\r\n/m);
    s.write(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\nTest automatique Freda (peut être supprimé).\r\n.\r\n`);
    if (!/^250/m.test(await s.expect(/^(250|[45]\d\d) [^\r\n]*\r\n/m))) throw new Error('message refusé');
    s.write('QUIT\r\n');
  } finally { s.close(); }
}

(async () => {
  const cfg = loadConfig(process.env);
  const domain = String(process.env.PURELYMAIL_TEST_DOMAIN || '').trim().toLowerCase();
  if (!args.includes('--yes') || !cfg.purelymail.apiKey || !domain) {
    console.error('Usage : PURELYMAIL_API_KEY=… PURELYMAIL_TEST_DOMAIN=domaine.com node scripts/purelymail-live-check.js --yes [--deliver]\nCrée puis supprime UNE boîte jetable (fredatest-xxxx@domaine) ; ne touche à rien d’autre.');
    process.exit(2);
  }
  const smtp = { host: process.env.SMTP_HOST || 'smtp.purelymail.com', port: Number(process.env.SMTP_PORT) || 465, secure: process.env.SMTP_SECURE !== 'false' };
  const pm = createPurelymail(cfg, () => {});
  const local = 'fredatest-' + hex(4), addr = `${local}@${domain}`;
  const alias = 'susp-' + hex(5), renamed = `${alias}@${domain}`;
  const PW1 = 'Test-' + hex(10) + '!A1', PW2 = 'Test-' + hex(10) + '!B2', WRONG = 'Wrong-' + hex(8) + '!Z9';
  const login = (user, pass) => imapLogin({ host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure, user, pass });
  let failed = 0, created = false, currentLocal = local;
  const check = async (name, fn) => {
    try { const note = await fn(); console.log('PASS ', name + (note ? ' — ' + note : '')); return true; }
    catch (e) { failed++; console.log('FAIL ', name + ' — ' + e.message); return false; }
  };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  console.log(`Boîte jetable : ${addr}  (IMAP ${cfg.imap.host}:${cfg.imap.port}, SMTP ${smtp.host}:${smtp.port})\n`);
  try {
    if (!await check('clé API valide et domaine de test présent dans le compte', async () => {
      const domains = await pm.listDomains();
      must(domains.includes(domain), `${domain} n’est pas dans votre compte Purelymail (domaines : ${domains.slice(0, 5).join(', ') || 'aucun'}) : ajoutez-le d’abord`);
    })) throw new Error('arrêt : prérequis manquant');

    if (!await check('createUser (partie locale + domainName)', async () => { await pm.createUser({ local, domain, password: PW1 }); created = true; })) throw new Error('arrêt : création impossible');

    await check('connexion IMAP AUTHENTICATE PLAIN : bon mot de passe accepté', async () => {
      let r; for (let i = 0; i < 6 && r !== 'ok'; i++) { r = await login(addr, PW1); if (r !== 'ok') await sleep(1500); }
      must(r === 'ok', 'refusé alors que le mot de passe est correct (le serveur exige-t-il autre chose que AUTHENTICATE PLAIN ?)');
    });
    await check('connexion IMAP : mauvais mot de passe refusé', async () => { must((await login(addr, WRONG)) === 'denied', 'accepté à tort'); });

    let appPw = '';
    await check('push : createAppPassword (identifiant de surveillance) accepté par IMAP', async () => {
      appPw = await pm.createAppPassword({ local, domain, name: 'Freda push (test)' });
      must(appPw, 'aucun mot de passe d’application renvoyé');
      let r; for (let i = 0; i < 4 && r !== 'ok'; i++) { r = await login(addr, appPw); if (r !== 'ok') await sleep(1500); }
      must(r === 'ok', 'IMAP refuse le mot de passe d’application (portées IMAP non accordées par défaut ?)');
    });
    if (args.includes('--deliver') && appPw) {
      await check('push : l’observateur IMAP IDLE détecte un nouveau message (avec l’identifiant de surveillance)', async () => {
        let uid = null, got = null;
        const w = watchMailbox({ imap: cfg.imap, user: addr, pass: appPw, preview: false, log: () => {}, getLastUid: () => uid, setLastUid: (u) => { uid = u; }, onNew: (i) => { got = i; }, onDenied: () => {} });
        try {
          await Promise.race([w.ready, sleep(20000).then(() => { throw new Error('l’observateur n’a pas atteint IDLE en 20 s (serveur sans IDLE / STATUS ?)'); })]);
          await smtpSend(smtp, { user: addr, pass: PW1, from: addr, to: addr, subject: 'freda-push-' + hex(4) });
          for (let i = 0; i < 12 && !got; i++) await sleep(2500);
          must(got && got.count >= 1, 'aucune détection de nouveau message en 30 s (UIDNEXT / EXISTS ?)');
        } finally { w.stop(); }
      });
    }

    await check('suspension par renommage (modifyUser newUserName) : l’ancienne adresse est refusée', async () => {
      await pm.modifyUser({ local, domain, newLocal: alias }); currentLocal = alias;
      must((await login(addr, PW1)) === 'denied', 'l’ancienne adresse fonctionne encore : le renommage ne bloque pas l’accès');
    });
    await check('le mot de passe n’a pas changé (le nouveau nom accepte le même mot de passe)', async () => { must((await login(renamed, PW1)) === 'ok', 'mot de passe perdu par le renommage'); });

    let ruleId = null;
    await check('règle de routage ancienne adresse -> boîte renommée : créée puis retrouvée par listRoutingRules', async () => {
      const r = await pm.createRoutingRule({ domain, local, targets: [renamed] });
      const found = await pm.findRules({ domain, local, target: renamed });
      must(found.length === 1, 'règle introuvable après création'); ruleId = found[0].id;
      return r.id ? 'id ' + r.id : 'id retrouvé par la liste';
    });

    if (args.includes('--deliver')) {
      await check('courrier envoyé à l’ancienne adresse -> arrive dans la boîte renommée (messages conservés)', async () => {
        const subject = 'freda-test-' + hex(6);
        await smtpSend(smtp, { user: renamed, pass: PW1, from: renamed, to: addr, subject });
        let ok = false; for (let i = 0; i < 12 && !ok; i++) { await sleep(2500); ok = await imapInboxHas(cfg, { user: renamed, pass: PW1, subject }); }
        must(ok, 'message non reçu en 30 s : la règle ne livre pas vers la boîte renommée (domaine sans MX Purelymail ?)');
      });
    }

    await check('réactivation : règle supprimée puis ancien nom rétabli, mêmes identifiants', async () => {
      for (const r of await pm.findRules({ domain, local, target: renamed })) await pm.deleteRoutingRule(r.id);
      must((await pm.findRules({ domain, local })).length === 0, 'règle encore présente');
      await pm.modifyUser({ local: alias, domain, newLocal: local }); currentLocal = local;
      must((await login(addr, PW1)) === 'ok', 'ancienne adresse refusée après réactivation');
      must((await login(renamed, PW1)) === 'denied', 'le nom de suspension fonctionne encore');
    });

    await check('push : l’identifiant de surveillance suit la réactivation, puis deleteAppPassword le révoque', async () => {
      if (!appPw) throw new Error('pas d’identifiant à tester (étape précédente en échec)');
      must((await login(addr, appPw)) === 'ok', 'identifiant de surveillance refusé après réactivation (les mots de passe d’application ne suivent pas le renommage ?)');
      await pm.deleteAppPassword({ local, domain, appPassword: appPw });
      must((await login(addr, appPw)) === 'denied', 'mot de passe d’application encore accepté après révocation');
    });

    await check('changement de mot de passe (modifyUser newPassword) : ancien refusé, nouveau accepté', async () => {
      await pm.modifyUser({ local, domain, password: PW2 });
      must((await login(addr, PW1)) === 'denied', 'ancien mot de passe encore accepté');
      must((await login(addr, PW2)) === 'ok', 'nouveau mot de passe refusé');
    });
  } catch (e) {
    console.log('\n' + e.message);
  } finally {
    if (created) {
      console.log('\nNettoyage…');
      try { for (const l of [local, alias]) for (const r of await pm.findRules({ domain, local: l })) await pm.deleteRoutingRule(r.id); } catch (e) { console.log('  règles : ' + e.message); }
      try { await pm.deleteUser({ local: currentLocal, domain }); console.log('  boîte jetable supprimée'); }
      catch (e) { failed++; console.log(`  ÉCHEC de suppression : supprimez ${currentLocal}@${domain} à la main (portail Purelymail > Users) — ${e.message}`); }
    }
    console.log(failed ? `\n${failed} vérification(s) en échec.` : '\nToutes les vérifications ont réussi.');
    process.exit(failed ? 1 : 0);
  }
})();
