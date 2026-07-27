'use strict';

/**
 * Recovery rules for the mutation sweep's crash journal.
 *
 * The sweep proves that every guard in this repository has a test watching it,
 * so its own result is load-bearing: "0 survived" is the sentence the audit
 * rests on. It edits real source files one at a time and puts each one back,
 * and the journal is what puts a file back after a SIGKILL that no handler can
 * catch.
 *
 * That made the journal shared mutable state between processes, and it was
 * wrong in a way that produced a false audit result: any invocation that found
 * a journal restored it, including the read-only `--check-anchors`. Running
 * that check beside a live sweep restored the file the sweep was testing, so
 * the mutation was scored against unmutated source and reported as a survivor.
 *
 * These rules were verified by hand when they were written, which is exactly
 * the standard this audit refuses to accept anywhere else. They are asserted
 * here instead, against a throwaway journal and a throwaway target, so nothing
 * touches the repository's own journal or sources.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');
const sweep = path.join(repoRoot, 'scripts/stage4-mutation-sweep.mjs');

/** A pid that has certainly exited: the child is reaped before this returns. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

/**
 * Runs the sweep with a journal of our own.
 *
 * `--only` is given a name no mutation has, so the run recovers (or refuses),
 * validates anchors, mutates nothing and exits. That keeps these tests to a
 * subprocess spawn each while still exercising the real startup path rather
 * than a copy of it.
 */
function runSweep(args, journalPath) {
  return spawnSync(process.execPath, [sweep, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, RCC_SWEEP_JOURNAL: journalPath },
  });
}

function withJournal(pid, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-journal-'));
  try {
    const target = path.join(dir, 'guarded-source.txt');
    const journalPath = path.join(dir, 'journal.json');
    fs.writeFileSync(target, 'MUTATED');
    fs.writeFileSync(journalPath, JSON.stringify({ pid, target, original: 'ORIGINAL' }));
    body({ target, journalPath, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a sweep restores a journal its owner did not live to restore', () => {
  withJournal(deadPid(), ({ target, journalPath }) => {
    const result = runSweep(['--only', 'no-mutation-has-this-name'], journalPath);
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL',
      'a sweep killed mid-mutation must leave its guard restored for the next run');
    assert.equal(fs.existsSync(journalPath), false, 'a spent journal must not be left behind');
    assert.match(result.stderr, /recovered .*guarded-source\.txt/);
  });
});

test('a sweep refuses to touch a journal whose owner is still running', () => {
  // pid 1 is always present. On an unprivileged run this is also the EPERM
  // case: the signal cannot be delivered, and the process is alive regardless.
  withJournal(1, ({ target, journalPath, dir }) => {
    const result = runSweep(['--only', 'no-mutation-has-this-name'], journalPath);
    assert.equal(fs.readFileSync(target, 'utf8'), 'MUTATED',
      'restoring another sweep\'s file scores its mutation against unmutated source');
    assert.equal(fs.existsSync(journalPath), true, 'the running sweep still owns its journal');
    assert.notEqual(result.status, 0, 'the second sweep must fail rather than proceed');
    assert.match(result.stderr, /refusing to run two at once/);
    assert.ok(!fs.existsSync(path.join(dir, 'unexpected')), 'no other file may be produced');
  });
});

test('a process owned by somebody else counts as alive, not as gone', {
  skip: process.getuid && process.getuid() === 0
    ? 'running as root, so pid 1 answers without EPERM and this proves nothing'
    : false,
}, () => {
  // Signal 0 against pid 1 fails for an unprivileged caller with EPERM, which
  // means "it is there and you may not touch it" — the opposite of ESRCH. Read
  // as "gone", it would restore a sweep another user is running, so the
  // distinction is asserted from the outside here: the refusal above can only
  // have come from the EPERM branch.
  let code = null;
  try {
    process.kill(1, 0);
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, 'EPERM', 'this test only means anything if pid 1 is not ours');

  withJournal(1, ({ target, journalPath }) => {
    const result = runSweep(['--only', 'no-mutation-has-this-name'], journalPath);
    assert.match(result.stderr, /refusing to run two at once/,
      'EPERM must be read as alive; reading it as gone silently clobbers another run');
    assert.equal(fs.readFileSync(target, 'utf8'), 'MUTATED');
  });
});

test('checking anchors never writes, even with a journal in front of it', () => {
  // The read-only check is what caused the false survivor. It must not restore,
  // and it must not clear the journal either: the sweep that owns it is going
  // to need it.
  withJournal(deadPid(), ({ target, journalPath }) => {
    // Deliberately not asserting the exit status: that reports whether the
    // repository's anchors resolve, which is a different question, and tying
    // this test to it would make a stale anchor anywhere look like a journal
    // defect here.
    const result = runSweep(['--check-anchors'], journalPath);
    assert.equal(fs.readFileSync(target, 'utf8'), 'MUTATED',
      'a read-only check must not rewrite a source file');
    assert.equal(fs.existsSync(journalPath), true,
      'a read-only check must not consume a journal it does not own');
    assert.doesNotMatch(result.stderr, /recovered/);
  });
});

test('a journal names the process holding it, and that process is not helped', async () => {
  // Without a pid there is no way to tell "a sweep died holding this" from "a
  // sweep is holding this right now", and the safe-looking choice — restore —
  // is the destructive one.
  //
  // Asserted through the module rather than against its text. The first version
  // of this test matched the sweep script's source for the pid, which passed
  // for the wrong reason: the string it found was the mutation table entry
  // naming this very guard, not the guard. Removing the pid left it green.
  const { createJournal } = await import(
    pathToFileURL(path.join(repoRoot, 'scripts/lib/sweep-journal.mjs')).href);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-journal-'));
  try {
    const target = path.join(dir, 'guarded-source.txt');
    const journalPath = path.join(dir, 'journal.json');
    fs.writeFileSync(target, 'ORIGINAL');

    createJournal(journalPath).begin(target, 'ORIGINAL');
    const written = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(written.pid, process.pid, 'the journal must name the process that wrote it');

    // The round trip that matters: a second holder of the same journal must
    // refuse, because the process named in it — this one — is still running.
    assert.throws(() => createJournal(journalPath).recover(),
      /refusing to run two at once/,
      'a journal whose owner is alive must never be recovered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
