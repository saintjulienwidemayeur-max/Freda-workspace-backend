/** Validation et normalisation des noms de domaine (même logique que le frontend, revalidée côté serveur). */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeQuery(raw, knownTlds) {
  let q = String(raw || '').trim().toLowerCase();
  q = q.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  q = q.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-');
  let tld = null;
  const dot = q.indexOf('.');
  if (dot > -1) { tld = q.slice(dot); q = q.slice(0, dot); }
  const label = q.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!label) return { error: 'Saisissez un nom, par exemple « maboutique ».' };
  if (label.length < 2) return { error: 'Le nom doit contenir au moins 2 caractères.' };
  if (label.length > 63) return { error: 'Le nom ne peut pas dépasser 63 caractères.' };
  const known = knownTlds.includes(tld);
  return { label, tld: known ? tld : null, unknownTld: tld && !known ? tld : null };
}

/** Domaine complet valide dont l'extension est autorisée : { label, tld } ou null. */
/** Extensions annoncées « bientôt » : jamais vendues, même si elles se retrouvent dans DOMAIN_TLDS. */
const COMING_SOON = ['.ht'];
function parseDomain(domain, knownTlds) {
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  const dot = d.indexOf('.');
  if (dot < 1) return null;
  const label = d.slice(0, dot), tld = d.slice(dot);
  if (!LABEL.test(label) || label.slice(2, 4) === '--' || !knownTlds.includes(tld) || COMING_SOON.includes(tld)) return null;
  return { label, tld, domain: label + tld };
}

module.exports = { normalizeQuery, parseDomain };
