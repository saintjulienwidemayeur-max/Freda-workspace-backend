-- Réglages modifiables depuis l'administration (sans redéploiement) : marge sur les noms de domaine, etc.
-- Absent = valeur par défaut des variables d'environnement (PRICE_MARKUP_PERCENT, PRICE_MIN_MARKUP).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
