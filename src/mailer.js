
/* ---------- Habillage de marque : tout e-mail sans HTML est mis en forme (logo, couleurs, bouton, pied de page légal) à partir de son texte ---------- */
const SITE = 'https://fredaworkspace.com';
const C = { midnight: '#061137', navy: '#071653', blue: '#2B64E4', mist: '#EEF3FD', slate: '#5B6478', amber: '#F5B83D', line: '#DCE5F7' };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Typographie française : espace insécable avant : ; ! ? » et après « ; la dernière paire de mots d'un titre reste liée (pas de veuve). */
const fr = (t) => String(t).replace(/ ([:;!?»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
const URL_RE = /https?:\/\/[^\s)]+/g;
const linkify = (t) => fr(esc(t)).replace(/https?:\/\/[^\s)&]+(?:&amp;[^\s)&]+)*/g, (u) => `<a href="${u}" style="color:${C.blue};text-decoration:underline;word-break:break-all">${u}</a>`);
const CTA = [[/reset=/, 'Choisir un nouveau mot de passe'], [/topup/, 'Recharger mon solde'], [/domaines\?renew=/, 'Renouveler mon domaine'], [/dns/, 'Gérer mon DNS'], [/entreprise/, 'Configurer mon entreprise'], [/facturation/, 'Ouvrir ma facturation'], [/connexion/, 'Me connecter'], [/domaines/, 'Mes domaines']];
const ctaLabel = (u) => (CTA.find(([re]) => re.test(u)) || [0, 'Ouvrir mon espace'])[1];
const isSecret = (l) => /^[^\s@]+@\S+ : \S+/.test(l) || /^Mot de passe initial : \S+/.test(l);

function brandedHtml({ subject, text }) {
  const paras = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const signature = /^(Merci,|L['’]équipe Freda Workspace|Freda Workspace)$/;   // la signature est ajoutée par l'habillage
  while (paras.length > 1) {
    const lines = paras[paras.length - 1].split('\n');
    while (lines.length && signature.test(lines[lines.length - 1].trim())) lines.pop();
    if (lines.length) { paras[paras.length - 1] = lines.join('\n'); break; }
    paras.pop();
  }
  let button = null;
  const body = paras.map((para, i) => {
    const lines = para.split('\n'), out = [];
    for (const line of lines) {
      const m = !button && !isSecret(line) && /^(.*?)\s*:?\s*(https?:\/\/[^\s]*[^\s.,;:!?)])[.,;:!?)]*$/.exec(line);
      if (m && !/\([^)]*$/.test(m[1])) { button = { url: m[2], label: ctaLabel(m[2]) }; if (m[1].trim()) out.push(fr(esc(m[1].trim()))); out.push('\u0000BUTTON\u0000'); }
      else if (isSecret(line)) out.push(`<span style="display:block;margin:6px 0;padding:10px 12px;background:${C.mist};border:1px solid ${C.line};border-radius:8px;font-family:Consolas,Menlo,monospace;font-size:14px;color:${C.midnight};word-break:break-all">${esc(line)}</span>`);
      else out.push(linkify(line));
    }
    const html = out.join('<br>').replace(/<br>(<span style="display:block)/g, '$1');
    const style = i === 0 && /^Bonjour/.test(para) ? `margin:0 0 16px;font-size:16px;font-weight:700;color:${C.midnight}` : `margin:0 0 16px;font-size:15px;line-height:1.65;color:#2B3245`;
    const mark = '\u0000BUTTON\u0000';
    if (html.includes(mark)) {
      const [a, b] = html.split(mark), a2 = a.replace(/<br>$/, ''), b2 = b.replace(/^<br>/, '');
      return (a2 ? `<p style="${style}">${a2}</p>` : '') + mark + (b2 ? `<p style="${style}">${b2}</p>` : '');
    }
    return `<p style="${style}">${html}</p>`;
  }).join('');
  const btnHtml = button ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px"><tr><td bgcolor="${C.blue}" style="border-radius:10px;background:${C.blue};padding:14px 28px"><a href="${esc(button.url)}" style="font-family:Manrope,Inter,Arial,sans-serif;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none">${esc(button.label)}</a></td></tr></table><p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:${C.slate}">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><a href="${esc(button.url)}" style="color:${C.blue};word-break:break-all">${esc(button.url)}</a></p>` : '';
  const content = body.replace('\u0000BUTTON\u0000', btnHtml);
  // aperçu de la boîte de réception : jamais de secret (mot de passe) ni de lien
  const pick = paras.slice(/^Bonjour/.test(paras[0] || '') ? 1 : 0).map((p) => p.split('\n').filter((l) => !isSecret(l)).join(' ')).find((p) => p.trim());
  const first = String(pick || '').replace(URL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 110).replace(/\s*:$/, '');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.mist};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.mist}">${esc(first)}${'&zwnj;&nbsp;'.repeat(30)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.mist}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;font-family:Inter,Arial,Helvetica,sans-serif">
<tr><td bgcolor="${C.navy}" style="background:${C.navy};border-radius:16px 16px 0 0;padding:26px 32px"><a href="${SITE}" style="text-decoration:none"><img src="${SITE}/assets/email/logo-reverse.png" width="190" height="69" alt="Freda Workspace" style="display:block;border:0;height:auto;max-width:190px"></a></td></tr>
<tr><td style="height:4px;background:${C.amber};line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td bgcolor="#FFFFFF" style="background:#FFFFFF;padding:32px 32px 12px;border-left:1px solid ${C.line};border-right:1px solid ${C.line}">
<h1 style="margin:0 0 22px;font-family:Manrope,Inter,Arial,sans-serif;font-size:22px;line-height:1.3;font-weight:800;color:${C.midnight}">${fr(esc(subject)).replace(/\u00a0?([^\s\u00a0]+)\s+([^\s\u00a0]+)$/, ' $1\u00a0$2').trim()}</h1>
${content}
<p style="margin:8px 0 22px;font-size:15px;color:#2B3245">L’équipe Freda Workspace</p>
</td></tr>
<tr><td style="background:#FFFFFF;border:1px solid ${C.line};border-top:0;border-radius:0 0 16px 16px;padding:0 32px 26px"><div style="border-top:1px solid ${C.line};padding-top:18px;font-size:13px;line-height:1.6;color:${C.slate}">Une question\u00a0? Écrivez-nous à <a href="mailto:support@fredaworkspace.com" style="color:${C.blue}">support@fredaworkspace.com</a>, du lundi au samedi, de 8 h à 18 h (heure d’Haïti), en français, en créole haïtien ou en anglais.</div></td></tr>
<tr><td style="padding:18px 8px 0;text-align:center;font-size:12px;line-height:1.7;color:${C.slate}">
<a href="${SITE}" style="color:${C.slate}">fredaworkspace.com</a> &nbsp;·&nbsp; <a href="${SITE}/legal#cgu" style="color:${C.slate}">Conditions</a> &nbsp;·&nbsp; <a href="${SITE}/legal#confidentialite" style="color:${C.slate}">Confidentialité</a><br>
© ${new Date().getFullYear()} Freda Pay LLC. Tous droits réservés. Freda Workspace est une marque de Freda Pay LLC.<br>30 N Gould St Ste R, Sheridan, WY 82801, USA</td></tr>
</table></td></tr></table></body></html>`;
}

/** E-mails transactionnels : « console » (développement/tests, garde les messages en mémoire) ou « brevo » (API HTTP v3, comme Freda Pay). */
function createMailer(cfg, log) {
  const sent = [];
  async function send({ to, subject, text, html }) {
    const msg = { to, subject, text, html: html || brandedHtml({ subject, text }) };
    if (cfg.mailer.provider === 'brevo') {
      const res = await fetch(cfg.mailer.brevoUrl, {
        method: 'POST',
        headers: { 'api-key': cfg.mailer.brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: cfg.mailer.senderName, email: cfg.mailer.senderEmail }, to: [{ email: to }], subject, htmlContent: msg.html, textContent: text + '\n\n--\nFreda Workspace · une marque de Freda Pay LLC\nsupport@fredaworkspace.com', replyTo: { email: 'support@fredaworkspace.com', name: cfg.mailer.senderName },
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

/** Nom affiché dans « Bonjour … » : sans URL, sans saut de ligne, 60 caractères au plus (un nom piégé ne devient ni lien ni bouton). */
const nm = (u) => String((u && u.name) || '').replace(/https?:\/\/\S+/gi, '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const money = (n) => '$' + Number(n).toFixed(2);
const templates = {
  welcome: (u, app) => ({ subject: 'Bienvenue sur Freda Workspace', text: `Bonjour ${nm(u)},\n\nVotre compte est créé. Configurez votre entreprise et choisissez votre domaine :\n${app}/entreprise\n\nL'équipe Freda Workspace` }),
  reset: (u, link) => ({ subject: 'Réinitialisation de votre mot de passe', text: `Bonjour ${nm(u)},\n\nPour choisir un nouveau mot de passe (lien valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.` }),
  receipt: (u, o, app) => ({ subject: `Reçu ${o.reference} · ${money(o.amount)}`, text: `Bonjour ${nm(u)},\n\nNous avons bien reçu votre paiement de ${money(o.amount)} (référence ${o.reference}).\nVos factures sont dans votre espace : ${app}/espace/facturation\n\nMerci,\nFreda Workspace` }),
  domainRegistered: (u, names, app) => ({ subject: names.length > 1 ? 'Vos domaines sont enregistrés' : `Domaine enregistré : ${names[0]}`, text: `Bonjour ${nm(u)},\n\n${names.join(', ')} ${names.length > 1 ? 'sont enregistrés' : 'est enregistré'} sur votre compte.\nGérez le DNS : ${app}/espace/dns\n\nFreda Workspace` }),
  paymentLink: (u, label, link, due) => ({ subject: `À payer : ${label}`, text: `Bonjour ${nm(u)},\n\n${label} arrive à échéance le ${due}. Réglez-le ici (MonCash / NatCash) :\n${link}\n\nSans paiement avant cette date, le service pourrait être suspendu.\nFreda Workspace` }),
  domainExpiring: (u, name, days, link) => ({ subject: days > 0 ? `Le domaine ${name} expire dans ${days} jour${days > 1 ? 's' : ''}` : `Le domaine ${name} a expiré`, text: `Bonjour ${nm(u)},\n\n${days > 0 ? `${name} expire dans ${days} jour${days > 1 ? 's' : ''}.` : `${name} a expiré.`} Renouvelez-le en quelques clics (MonCash / NatCash) :\n${link}\n\nFreda Workspace` }),
  subscriptionDue: (u, plan, days, link) => ({ subject: days > 0 ? `Votre offre ${plan} se renouvelle dans ${days} jour${days > 1 ? 's' : ''}` : `Votre offre ${plan} est à régler`, text: `Bonjour ${nm(u)},\n\nVotre offre Freda Mail ${plan} ${days > 0 ? `se renouvelle dans ${days} jour${days > 1 ? 's' : ''}` : 'est arrivée à échéance'}. Réglez-la ici (MonCash / NatCash) :\n${link}\n\nFreda Workspace` }),
  subscriptionCancelled: (u, plan, endDate, link) => ({ subject: `Votre offre ${plan} est résiliée`, text: `Bonjour ${nm(u)},\n\nVotre offre Freda Mail ${plan} ne sera pas renouvelée. Vos boîtes restent utilisables jusqu'au ${endDate}, aucun nouveau prélèvement n'aura lieu.\nVous changez d'avis ? Reprenez l'offre avant cette date : ${link}\n\nFreda Workspace` }),
  mailboxesSuspended: (u, plan, link) => ({ subject: 'Vos boîtes mail sont suspendues', text: `Bonjour ${nm(u)},\n\nVotre offre Freda Mail ${plan} n'est plus active : l'accès à vos boîtes est suspendu. Vos messages sont conservés et le courrier entrant continue d'arriver.\nRéactivez l'offre ici pour retrouver l'accès : ${link}\n\nFreda Workspace` }),
  mailboxesReactivated: (u, boxes, link) => ({ subject: 'Vos boîtes mail sont réactivées', text: `Bonjour ${nm(u)},\n\nMerci pour votre paiement : vos boîtes sont de nouveau accessibles.\n${boxes.some((b) => b.password) ? `Un nouveau mot de passe a été défini (changez-le dès la connexion sur ${link}) :\n\n${boxes.map((b) => `${b.address} : ${b.password || '(inchangé)'}`).join('\n')}\n` : `Retrouvez-les dans l'application avec les mêmes identifiants : ${boxes.map((b) => b.address).join(', ')} (votre mot de passe n'a pas changé).\n`}\nFreda Workspace` }),
  balanceLow: (u, d) => ({ subject: d.days > 0 ? `Solde insuffisant : votre offre ${d.plan} se renouvelle dans ${d.days} jour${d.days > 1 ? 's' : ''}` : `Solde insuffisant : votre offre ${d.plan} est à régler`, text: `Bonjour ${nm(u)},\n\nVotre offre Freda Mail ${d.plan} (${money(d.price)}) ${d.days > 0 ? `se renouvelle dans ${d.days} jour${d.days > 1 ? 's' : ''}` : 'est arrivée à échéance'}, mais votre solde Freda Workspace n'est que de ${money(d.balance)}.\nIl manque ${money(d.missing)} (environ ${d.missingHtg} HTG).\n\nAjoutez de l'argent à votre solde avec MonCash ou NatCash :\n${d.link}\n\nDès que le solde suffit, l'offre est renouvelée automatiquement. Sans paiement, vos boîtes mail seront suspendues (vos messages sont conservés).\nFreda Workspace` }),
  topupReceipt: (u, d) => ({ subject: `Recharge reçue : ${money(d.amount)}`, text: `Bonjour ${nm(u)},\n\nVotre solde Freda Workspace a été rechargé de ${money(d.amount)} (référence ${d.reference}). Nouveau solde : ${money(d.balance)}.\nVos offres et renouvellements seront payés automatiquement avec ce solde.\n${d.link}\n\nFreda Workspace` }),
  paidFromBalance: (u, d) => ({ subject: `${d.label} payé avec votre solde`, text: `Bonjour ${nm(u)},\n\n${d.label} (${money(d.amount)}) a été payé avec votre solde. Solde restant : ${money(d.balance)}.\n${d.link}\n\nFreda Workspace` }),
  renewalFailed: (u, name) => ({ subject: `Le domaine ${name} n'a pas pu être renouvelé`, text: `Bonjour ${nm(u)},\n\nVotre paiement est bien reçu mais le renouvellement de ${name} a échoué. Notre équipe a été alertée et vous contacte rapidement.\nFreda Workspace` }),
};
module.exports = { createMailer, templates, nm };
