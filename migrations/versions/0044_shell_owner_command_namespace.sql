-- CON-FR-007/018/020: the durable ledger stores commands of installed owners.
-- Existing hiss.* receipts remain unchanged; authority, MFA and the two RPCs
-- are unchanged. Syntax acceptance is not authorization: OS Shell admits only
-- its native commands and freshly verified signed owner contracts.
ALTER TABLE console_shell.command_request
  DROP CONSTRAINT command_request_command_check;
ALTER TABLE console_shell.command_request
  ADD CONSTRAINT command_request_command_check CHECK (
    length(command) BETWEEN 3 AND 128
    AND command ~ '^[a-z0-9]+([.-][a-z0-9]+)+$'
  );
