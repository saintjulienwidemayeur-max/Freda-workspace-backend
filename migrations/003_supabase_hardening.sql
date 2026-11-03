-- Durcissement propre à Supabase (sans effet ailleurs) : la fonction d'aide « rls_auto_enable » (déclencheur d'événement qui active RLS sur les nouvelles tables)
-- ne doit pas être appelable depuis l'API publique (/rest/v1/rpc/rls_auto_enable). Les déclencheurs d'événement continuent de fonctionner : ils n'exigent pas EXECUTE pour l'appelant.
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated; END IF;
  END IF;
END $$;
