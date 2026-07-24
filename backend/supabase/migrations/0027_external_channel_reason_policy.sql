-- External Channel audit reasons are descriptive metadata, not an
-- authorization factor. The Console continues to preserve any supplied text
-- in append-only audit evidence, but it must not reject an operation because
-- the operator used fewer than eight characters or left the optional field
-- empty.
ALTER TABLE console.configuration_restore
  DROP CONSTRAINT IF EXISTS configuration_restore_reason_check;

COMMENT ON COLUMN console.configuration_restore.reason IS
  'Optional operator-supplied audit context; no minimum length is imposed.';
