\set ON_ERROR_STOP on

-- PostgREST switches to the JWT role.  Table grants alone do not bypass RLS,
-- so the Console Backend needs an explicit server-side policy.  Browser roles
-- remain constrained by the self-service policies in 0001.
DROP POLICY IF EXISTS console_backend_operator ON console.operator;
CREATE POLICY console_backend_operator ON console.operator FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_operator_role ON console.operator_role;
CREATE POLICY console_backend_operator_role ON console.operator_role FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_user_setting ON console.user_setting;
CREATE POLICY console_backend_user_setting ON console.user_setting FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_change_request ON console.change_request;
CREATE POLICY console_backend_change_request ON console.change_request FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_role ON console.role;
CREATE POLICY console_backend_role ON console.role FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_permission ON console.permission;
CREATE POLICY console_backend_permission ON console.permission FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_role_permission ON console.role_permission;
CREATE POLICY console_backend_role_permission ON console.role_permission FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_plugin_meta ON console.plugin_meta;
CREATE POLICY console_backend_plugin_meta ON console.plugin_meta FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS audit_backend_event_read ON audit.event;
CREATE POLICY audit_backend_event_read ON audit.event FOR SELECT TO opensphere_console_backend
  USING (true);
DROP POLICY IF EXISTS audit_backend_event_insert ON audit.event;
CREATE POLICY audit_backend_event_insert ON audit.event FOR INSERT TO opensphere_console_backend
  WITH CHECK (true);
