const { HttpError } = require('./errors');
const { templates } = require('./mailer');

/** Réglages d'un domaine depuis l'espace client : verrouillage, rappels de renouvellement, demande du code de transfert (EPP). */
function createDomainSettings({ db, registrar, mailer, alert, log, cfg }) {
  const own = (userId, name) => {
    const d = db.get('SELECT * FROM domains WHERE user_id = ? AND name = ?', userId, String(name || '').toLowerCase());
    if (!d) throw new HttpError(404, 'Domaine introuvable.', 'not_found');
    return d;
  };
  const view = (d) => ({ name: d.name, locked: !!d.locked, autoRenew: !!d.auto_renew, status: d.status });

  async function update(userId, name, patch) {
    const d = own(userId, name);
    if (patch.locked !== undefined) {
      if (d.external) throw new HttpError(400, 'Le verrouillage se gère chez le registraire où le domaine est enregistré.', 'external_domain');
      if (d.status !== 'active') throw new HttpError(409, 'Ce domaine n’est pas actif.', 'inactive');
      const want = !!patch.locked;
      try { await (want ? registrar.lock(d.name) : registrar.unlock(d.name)); }
      catch (e) { log('error', 'lock_toggle_failed', { code: e.code }); throw new HttpError(502, 'Le registraire n’a pas accepté la modification. Réessayez.', 'registrar_error'); }
      db.run('UPDATE domains SET locked = ? WHERE id = ?', want ? 1 : 0, d.id);
    }
    if (patch.autoRenew !== undefined) {
      if (d.external) throw new HttpError(400, 'Le renouvellement se gère chez le registraire où le domaine est enregistré.', 'external_domain');
      db.run('UPDATE domains SET auto_renew = ? WHERE id = ?', patch.autoRenew ? 1 : 0, d.id);
    }
    return view(db.get('SELECT * FROM domains WHERE id = ?', d.id));
  }

  /** NameSilo envoie le code EPP au contact administratif du compte revendeur, pas au client : le support Freda le transmet. */
  async function requestTransferCode(userId, name) {
    const d = own(userId, name);
    if (d.external) throw new HttpError(400, 'Ce domaine n’est pas enregistré chez Freda.', 'external_domain');
    if (d.status !== 'active') throw new HttpError(409, 'Ce domaine n’est pas actif.', 'inactive');
    if (d.locked) throw new HttpError(409, 'Déverrouillez d’abord le domaine pour autoriser son transfert.', 'locked');
    try { await registrar.requestAuthCode(d.name); }
    catch (e) { log('error', 'auth_code_failed', { code: e.code }); throw new HttpError(502, 'Le registraire n’a pas accepté la demande. Réessayez.', 'registrar_error'); }
    const user = db.get('SELECT * FROM users WHERE id = ?', userId);
    await alert('info', 'Code de transfert (EPP) demandé : à transmettre au client', { domain: d.name, client: user.email });
    mailer.trySend({ to: user.email, subject: `Code de transfert demandé pour ${d.name}`, text: `Bonjour ${user.name || ''},\n\nVotre demande de code de transfert pour ${d.name} est enregistrée. Notre support vous l'envoie par e-mail sous 24 h ouvrées après vérification.\n\nFreda Workspace` });
    return { ok: true, message: 'Demande enregistrée. Notre support vous envoie le code par e-mail sous 24 h.' };
  }

  return { update, requestTransferCode };
}
module.exports = { createDomainSettings };
