-- Mot de passe de la boîte conservé CHIFFRÉ (AES-256-GCM, DATA_KEY) pour que le titulaire du compte puisse le revoir dans son espace client
-- (après avoir saisi le mot de passe de son compte). Vide = non conservé (boîtes créées avant cette fonction, ou mot de passe remplacé par un secret de suspension).
ALTER TABLE mailboxes ADD COLUMN password_enc TEXT NOT NULL DEFAULT '';
