-- Sécurité Supabase : toutes les tables sont privées. Le backend se connecte avec le rôle propriétaire de la base (contourne RLS) ;
-- l'API REST publique de Supabase (clé « anon » / « publishable ») ne doit jamais pouvoir lire ni écrire ces tables.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE dns_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE counters ENABLE ROW LEVEL SECURITY;
-- Ceinture et bretelles (uniquement sur Supabase, où les rôles anon / authenticated existent) : aucun droit pour les rôles de l'API publique, y compris sur les futures tables.
DO $$
DECLARE s text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM anon, authenticated', s);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM anon, authenticated', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM anon, authenticated', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM anon, authenticated', s);
  END IF;
END $$;
