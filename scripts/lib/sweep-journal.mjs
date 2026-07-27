/**
 * The mutation sweep's crash journal.
 *
 * The sweep edits a real source file, runs the test that claims to guard it,
 * and puts the file back. A signal handler covers an ordinary interruption, but
 * SIGKILL cannot be handled at all — so the journal records the untouched text
 * *before* the file is written, and the next run puts it back rather than
 * leaving a weakened guard on disk to be committed.
 *
 * It therefore lives outside any one process, which makes it shared mutable
 * state, and its first version got that wrong in a way that produced a false
 * audit result: every invocation restored whatever journal it found, including
 * the read-only anchor check. Running that check beside a live sweep restored
 * the file under test, so the mutation was scored against unmutated source and
 * reported as a survivor.
 *
 * Kept in its own module for two reasons. It can be imported and exercised
 * directly, and — because the sweep mutates itself to prove these rules are
 * watched — an anchor here occurs once, whereas an anchor in the sweep script
 * would also appear in the mutation table that names it and match twice.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Whether the process that wrote a journal is still running.
 *
 * Signal 0 tests for existence without delivering anything.
 */
export function journalOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that means "gone". EPERM means the process is
    // very much alive and simply belongs to somebody else — treating that as
    // dead would restore a sweep another user is running out from under it.
    return error?.code === 'EPERM';
  }
}

export function createJournal(journalPath) {
  let pending = null;

  return {
    path: journalPath,

    /** Records the original text before the file is mutated. */
    begin(target, original) {
      // The pid is what distinguishes "a sweep died holding this" from "a sweep
      // is holding this right now". Without it a second invocation cannot tell,
      // and the safe-looking choice — restore it — is the destructive one.
      writeFileSync(journalPath, JSON.stringify({ pid: process.pid, target, original }));
      pending = { target, original };
    },

    /** Puts back whatever this process was holding, and clears the journal. */
    restore() {
      if (pending) {
        writeFileSync(pending.target, pending.original);
        pending = null;
      }
      if (existsSync(journalPath)) rmSync(journalPath);
    },

    /**
     * Repairs a file an earlier run was killed while mutating.
     *
     * Returns the path restored, or null when there was nothing to do. Throws
     * when the journal belongs to a live process: two sweeps must not run at
     * once, and helping is the one thing the second must not do.
     *
     * `readOnly` is how a command that only inspects the tree — the anchor
     * check — declines to repair anything. The suppression lives here, beside
     * the writes it suppresses, rather than at the call site: this is the exact
     * path that restored a live sweep's file and produced a false survivor.
     */
    recover({ readOnly = false } = {}) {
      if (!existsSync(journalPath)) return null;
      if (readOnly) return null;
      const { pid, target, original } = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (journalOwnerAlive(pid)) {
        const error = new Error(
          `another sweep (pid ${pid}) is mutating ${target}; refusing to run two at once`);
        error.code = 'SWEEP_IN_PROGRESS';
        throw error;
      }
      writeFileSync(target, original);
      rmSync(journalPath);
      return target;
    },
  };
}
