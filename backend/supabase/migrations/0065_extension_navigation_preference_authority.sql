\set ON_ERROR_STOP on

-- Extension presentation is durable Console configuration, not part of the
-- signed UIPluginPackage descriptor. The DUPA controller already holds the
-- service_role credential for its bounded audit and revocation responsibilities;
-- grant it only the existing plugin metadata table needed to preserve operator
-- navigation choices across package replacement. No browser role receives this
-- authority and plugin_meta remains part of the Console configuration backup.
GRANT SELECT, INSERT, UPDATE ON TABLE console.plugin_meta TO service_role;

COMMENT ON TABLE console.plugin_meta IS
  'Durable Console-owned plugin metadata. record.navigation owns operator icon, labelOverride and order; signed UIPluginPackage owns descriptor defaults.';
