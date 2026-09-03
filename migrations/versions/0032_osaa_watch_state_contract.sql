-- CON-FR-018 / C_AI: persist the complete runtime watcher state machine.
-- No new authority or data deletion; already applied migration 0031 is immutable.
ALTER TABLE osaa.watch_cursor DROP CONSTRAINT watch_cursor_status_check;
ALTER TABLE osaa.watch_cursor ADD CONSTRAINT watch_cursor_status_check
  CHECK (status IN ('starting','watching','reconnecting','stopped','error',
                    'discovery','discovery-error','unsupported'));
