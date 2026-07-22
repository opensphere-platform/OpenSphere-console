\set ON_ERROR_STOP on

-- PostgREST connects as `authenticator` and then assumes the JWT role.  The
-- Console Backend signs a private `opensphere_console_backend` JWT, so that
-- exact membership is required before it can use its constrained grants.
GRANT opensphere_console_backend TO authenticator;

-- DUPA uses the private service-role JWT only for the append-only audit feed
-- and image-revocation endpoint.  Do not turn it into a blanket Console DB
-- administrator; browser code never receives this JWT.
GRANT USAGE ON SCHEMA console, audit TO service_role;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA console FROM service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA console FROM service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA console FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA console
  REVOKE ALL ON TABLES FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA console
  REVOKE ALL ON SEQUENCES FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA audit
  REVOKE ALL ON TABLES FROM service_role;

GRANT SELECT ON console.image_revocation TO service_role;
GRANT SELECT, INSERT ON audit.event TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO service_role;
GRANT EXECUTE ON FUNCTION console.revoke_image(text, text, text, uuid, text, text, text, uuid, text) TO service_role;
