'use strict';
// Closed RPCs; neither request inputs nor credentials are persisted.
function createCommandLedger(query) {
  return {
    async claim(actor, requestId, command, digest) {
      const result = await query('SELECT console_shell.claim_command($1,$2,$3,$4,$5,$6) AS result',
        [actor.subjectId, actor.sessionId, requestId, command, digest, actor.aal]);
      return result.rows[0].result;
    },
    async finish(actor, requestId, digest, result) {
      await query('SELECT console_shell.finish_command($1,$2,$3,$4::jsonb)',
        [actor.subjectId, requestId, digest, JSON.stringify(result)]);
    },
  };
}
module.exports = {createCommandLedger};
