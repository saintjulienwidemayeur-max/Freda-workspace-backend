-- Révocation des sessions : un changement ou une réinitialisation de mot de passe invalide les jetons émis avant (comme pour les boîtes mail).
ALTER TABLE users ADD COLUMN tokens_valid_after BIGINT NOT NULL DEFAULT 0;
