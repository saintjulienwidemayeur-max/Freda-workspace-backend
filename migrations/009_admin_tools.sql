-- Outils d'administration : offres offertes par l'administrateur (journal) et annonces e-mail envoyées à tous les clients (avec le détail des envois,
-- pour ne JAMAIS envoyer deux fois le même message à la même personne, même après un redémarrage).
CREATE TABLE admin_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan TEXT NOT NULL, months INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
  starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX admin_grants_user ON admin_grants(user_id);
ALTER TABLE admin_grants ENABLE ROW LEVEL SECURITY;
CREATE TABLE announcements (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL, total INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT ''
);
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
CREATE TABLE announcement_deliveries (
  announcement_id TEXT NOT NULL REFERENCES announcements(id), user_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (announcement_id, user_id)
);
ALTER TABLE announcement_deliveries ENABLE ROW LEVEL SECURITY;
