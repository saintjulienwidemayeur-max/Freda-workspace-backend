/** E-mails transactionnels : « console » (développement/tests, garde les messages en mémoire) ou « brevo » (API HTTP v3, comme Freda Pay). */
function createMailer(cfg, log) {
  const sent = [];
  async function send({ to, subject, text, html }) {
    const msg = { to, subject, text, html: html || `<p>${String(text).replace(/\n/g, '<br>')}</p>` };
    if (cfg.mailer.provider === 'brevo') {
      const res = await fetch(cfg.mailer.brevoUrl, {
        method: 'POST',
        headers: { 'api-key': cfg.mailer.brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: cfg.mailer.senderName, email: cfg.mailer.senderEmail }, to: [{ email: to }], subject, htmlContent: msg.html, textContent: text,
          headers: { 'X-Category': 'Transactional', 'X-Auto-Response-Suppress': 'All' } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { log('error', 'mail_failed', { status: res.status }); throw new Error('Envoi d’e-mail impossible.'); }
    } else {
      sent.push(msg);
      log('info', 'mail_console', { to, subject });
    }
    return true;
  }
  /** Envoi « au mieux » : un échec d'e-mail ne doit jamais faire échouer un achat. */
  const trySend = (m) => send(m).catch(() => false);
  return { send, trySend, sent };
}

const money = (n) => '$' + Number(n).toFixed(2);
const templates = {
  welcome: (u, app) => ({ subject: 'Bienvenue sur Freda Workspace', text: `Bonjour ${u.name || ''},\n\nVotre compte est créé. Configurez votre entreprise et choisissez votre domaine :\n${app}/entreprise.html\n\nL'équipe Freda Workspace` }),
  reset: (u, link) => ({ subject: 'Réinitialisation de votre mot de passe', text: `Bonjour ${u.name || ''},\n\nPour choisir un nouveau mot de passe (lien valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.` }),
  receipt: (u, o, app) => ({ subject: `Reçu ${o.reference} · ${money(o.amount)}`, text: `Bonjour ${u.name || ''},\n\nNous avons bien reçu votre paiement de ${money(o.amount)} (référence ${o.reference}).\nVos factures sont dans votre espace : ${app}/espace/facturation.html\n\nMerci,\nFreda Workspace` }),
  domainRegistered: (u, names, app) => ({ subject: names.length > 1 ? 'Vos domaines sont enregistrés' : `Domaine enregistré : ${names[0]}`, text: `Bonjour ${u.name || ''},\n\n${names.join(', ')} ${names.length > 1 ? 'sont enregistrés' : 'est enregistré'} sur votre compte.\nGérez le DNS : ${app}/espace/dns.html\n\nFreda Workspace` }),
  paymentLink: (u, label, link, due) => ({ subject: `À payer : ${label}`, text: `Bonjour ${u.name || ''},\n\n${label} arrive à échéance le ${due}. Réglez-le ici (MonCash / NatCash) :\n${link}\n\nSans paiement avant cette date, le service pourrait être suspendu.\nFreda Workspace` }),
  domainExpiring: (u, name, days, link) => ({ subject: days > 0 ? `Le domaine ${name} expire dans ${days} jour${days > 1 ? 's' : ''}` : `Le domaine ${name} a expiré`, text: `Bonjour ${u.name || ''},\n\n${days > 0 ? `${name} expire dans ${days} jour${days > 1 ? 's' : ''}.` : `${name} a expiré.`} Renouvelez-le en quelques clics (MonCash / NatCash) :\n${link}\n\nFreda Workspace` }),
  subscriptionDue: (u, plan, days, link) => ({ subject: days > 0 ? `Votre offre ${plan} se renouvelle dans ${days} jour${days > 1 ? 's' : ''}` : `Votre offre ${plan} est à régler`, text: `Bonjour ${u.name || ''},\n\nVotre offre Freda Mail ${plan} ${days > 0 ? `se renouvelle dans ${days} jour${days > 1 ? 's' : ''}` : 'est arrivée à échéance'}. Réglez-la ici (MonCash / NatCash) :\n${link}\n\nFreda Workspace` }),
  subscriptionCancelled: (u, plan, endDate, link) => ({ subject: `Votre offre ${plan} est résiliée`, text: `Bonjour ${u.name || ''},\n\nVotre offre Freda Mail ${plan} ne sera pas renouvelée. Vos boîtes restent utilisables jusqu'au ${endDate}, aucun nouveau prélèvement n'aura lieu.\nVous changez d'avis ? Reprenez l'offre avant cette date : ${link}\n\nFreda Workspace` }),
  mailboxesSuspended: (u, plan, link) => ({ subject: 'Vos boîtes mail sont suspendues', text: `Bonjour ${u.name || ''},\n\nVotre offre Freda Mail ${plan} n'est plus active : l'accès à vos boîtes est suspendu. Vos messages sont conservés et le courrier entrant continue d'arriver.\nRéactivez l'offre ici pour retrouver l'accès : ${link}\n\nFreda Workspace` }),
  mailboxesReactivated: (u, boxes, link) => ({ subject: 'Vos boîtes mail sont réactivées', text: `Bonjour ${u.name || ''},\n\nMerci pour votre paiement : vos boîtes sont de nouveau accessibles.\n${boxes.some((b) => b.password) ? `Un nouveau mot de passe a été défini (changez-le dès la connexion sur ${link}) :\n\n${boxes.map((b) => `${b.address} : ${b.password || '(inchangé)'}`).join('\n')}\n` : `Retrouvez-les dans l'application avec les mêmes identifiants : ${boxes.map((b) => b.address).join(', ')} (votre mot de passe n'a pas changé).\n`}\nFreda Workspace` }),
  renewalFailed: (u, name) => ({ subject: `Le domaine ${name} n'a pas pu être renouvelé`, text: `Bonjour ${u.name || ''},\n\nVotre paiement est bien reçu mais le renouvellement de ${name} a échoué. Notre équipe a été alertée et vous contacte rapidement.\nFreda Workspace` }),
};
module.exports = { createMailer, templates };
