-- Photos de profil des boîtes Freda Mail (visibles uniquement par les autres utilisateurs de l'application, jamais publiques).
-- Octets en base64 (TEXT) : portable, 150 Ko maximum par photo ; supprimée avec la boîte.
CREATE TABLE mailbox_photos (
  mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE mailbox_photos ENABLE ROW LEVEL SECURITY;
