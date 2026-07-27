'use strict';

/**
 * The agent's systemd sandbox, and the one deliberate hole in it.
 *
 * The agent runs as root because its declared operations need root: reading the
 * full journal, restarting a unit, rebooting, installing a package. What makes
 * that defensible is the sandbox — the filesystem is read-only apart from the
 * agent's own state, capabilities are cut to what each operation needs, and
 * there is no listening socket.
 *
 * Stage 3 breaks part of that on purpose, because apt cannot install a package
 * inside it. The widening lives in a separate drop-in that an operator has to
 * install, so a host with the binary but without the drop-in keeps the Stage 2
 * sandbox and fails package operations closed. These assertions keep the two
 * files honest about which is which.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packagingDir = path.join(__dirname, '..', 'rcc-node-agent', 'packaging');
const unit = fs.readFileSync(path.join(packagingDir, 'rcc-node-agent.service'), 'utf8');
const dropIn = fs.readFileSync(path.join(packagingDir, 'package-maintenance.conf'), 'utf8');
const installer = fs.readFileSync(path.join(packagingDir, 'install.sh'), 'utf8');
const exampleConfig = JSON.parse(fs.readFileSync(path.join(packagingDir, 'agent.example.json'), 'utf8'));

/** Directive values as systemd would read them, last-wins within one file. */
function directives(text, name) {
  return [...text.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].map((m) => m[1].trim());
}

// ── the base unit stays as narrow as Stage 2 left it ────────────────────────

test('the base unit keeps the filesystem read-only apart from agent state', () => {
  assert.deepEqual(directives(unit, 'ProtectSystem'), ['strict'],
    'anything less than strict widens every host, including ones doing no package work');
  assert.deepEqual(directives(unit, 'ReadWritePaths'), ['/var/lib/rcc-node-agent'],
    'the agent state directory is the only writable path in the base unit');
});

test('the base unit grants exactly one capability', () => {
  assert.deepEqual(directives(unit, 'CapabilityBoundingSet'), ['CAP_SYS_BOOT'],
    'CAP_SYS_BOOT is what host.reboot needs; nothing else is justified without the drop-in');
  assert.deepEqual(directives(unit, 'AmbientCapabilities'), ['']);
  assert.deepEqual(directives(unit, 'NoNewPrivileges'), ['yes']);
});

test('the base unit denies the syscall groups a package install needs', () => {
  const filters = directives(unit, 'SystemCallFilter').join(' ');
  for (const group of ['@privileged', '@resources', '@mount', '@swap', '@module', '@obsolete']) {
    assert.ok(filters.includes(group), `${group} must be denied in the base unit`);
  }
  // Which is precisely why apt cannot run without the drop-in.
  assert.ok(filters.includes('~'), 'the deny list must be a subtraction');
});

test('the base unit exposes no listening socket and no shell', () => {
  assert.ok(!/ExecStart=.*(sh|bash)\s+-c/.test(unit), 'the agent is never started through a shell');
  assert.ok(!/ListenStream|ListenDatagram|Sockets=/.test(unit), 'the agent opens no inbound port');
  assert.deepEqual(directives(unit, 'RestrictAddressFamilies'), ['AF_INET AF_INET6 AF_UNIX']);
});

// ── package maintenance is off unless somebody turns it on twice ────────────

test('the shipped configuration enables no package maintenance', () => {
  assert.equal(exampleConfig.packagesEnabled, false,
    'installing a build that can update packages must not make a host updatable');
  assert.deepEqual(exampleConfig.packageAllowlist, [],
    'an empty allowlist means this host updates nothing');
  assert.equal(exampleConfig.operationsEnabled, false);
  // Reporting changes nothing, so inventory is on: a host can be observed
  // without being managed.
  assert.equal(exampleConfig.collectPackages, true);
});

test('SSH ban management is read-only by default and protects management addresses when enabled', () => {
  assert.equal(exampleConfig.collectSSHBan, true,
    'read-only Fail2ban status collection should be on by default');
  assert.equal(exampleConfig.sshBanEnabled, false,
    'installing the agent must not make the host ban-capable');
  assert.deepEqual(exampleConfig.sshBanProtectedAddresses, [],
    'the example cannot guess a host management address');
  assert.match(installer, /sshBanEnabled/);
  assert.match(installer, /sshBanProtectedAddresses/);
  assert.match(installer, /fixed sshd jail/i);
});

test('the drop-in is a separate file the base unit does not reference', () => {
  assert.ok(!unit.includes('package-maintenance'),
    'the widening must not be pulled in by the unit itself');
  assert.ok(!unit.includes('/var/lib/dpkg') && !unit.includes('/boot'),
    'no package paths belong in the base unit');
});

test('the installer says how to enable it and what happens without it', () => {
  assert.match(installer, /package and kernel maintenance is OFF/);
  assert.match(installer, /package-maintenance\.conf/);
  assert.match(installer, /packagesEnabled/);
  assert.match(installer, /fails closed/,
    'an operator must be told that the absence of the drop-in is safe, not broken');
});

// ── the drop-in widens only what a package install actually needs ───────────

test('the drop-in keeps the protections that are not in apt\'s way', () => {
  // These would still be true of a host doing package maintenance, so removing
  // them would be widening for no reason.
  for (const directive of ['ProtectHome', 'PrivateDevices', 'RestrictNamespaces', 'LockPersonality']) {
    assert.ok(!dropIn.includes(`${directive}=`),
      `${directive} must not be relaxed by the package drop-in`);
  }
  // @privileged is what dpkg actually needs. Everything else the base unit
  // denies stays denied, because nothing here re-adds it.
  const filters = directives(dropIn, 'SystemCallFilter').join(' ');
  for (const group of ['@mount', '@resources', '@swap', '@obsolete']) {
    assert.ok(!filters.includes(group), `${group} must stay denied even with package maintenance on`);
  }
});

test('the drop-in retains the reboot capability rather than replacing the set', () => {
  const caps = directives(dropIn, 'CapabilityBoundingSet');
  assert.equal(caps.length, 1);
  assert.ok(caps[0].includes('CAP_SYS_BOOT'),
    'host.reboot is still a declared operation on a host that also updates packages');
  // Only capabilities a dpkg transaction genuinely uses.
  const granted = caps[0].split(/\s+/).filter(Boolean);
  const expected = ['CAP_SYS_BOOT', 'CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FOWNER',
    'CAP_FSETID', 'CAP_SETUID', 'CAP_SETGID', 'CAP_MKNOD', 'CAP_AUDIT_WRITE'];
  assert.deepEqual(granted.sort(), expected.sort());
  for (const dangerous of ['CAP_SYS_ADMIN', 'CAP_SYS_MODULE', 'CAP_SYS_PTRACE', 'CAP_NET_ADMIN', 'CAP_SYS_RAWIO']) {
    assert.ok(!granted.includes(dangerous), `${dangerous} is not needed to install a package`);
  }
});

test('the drop-in states plainly that maintainer scripts are vendor code', () => {
  // This is the honest residual risk of package management, and the file that
  // enables it is the right place to say so.
  assert.match(dropIn, /maintainer scripts are vendor code that runs as root/);
  assert.match(dropIn, /residual risk/);
});

test('the drop-in explains why the widening cannot be avoided', () => {
  assert.match(dropIn, /apt cannot run inside that/);
  assert.match(dropIn, /fails closed/);
  assert.match(dropIn, /two things that a person has to do on purpose/);
});

test('SSH protection setup reuses but does not inherit the package sandbox authority', () => {
  const flat = prose(dropIn);
  assert.match(flat, /ssh\.protection\.enable/);
  assert.match(flat, /does NOT grant SSH authority by itself/);
  assert.match(flat, /protected management address/);
  assert.match(flat, /Both sides must be enabled deliberately or the operation fails closed/);
  assert.match(installer, /Installing and activating the fixed RCC Fail2ban baseline/);
  assert.match(installer, /The drop-in alone grants/);
});

test('the drop-in does not hand out a shell or an inbound port', () => {
  assert.ok(!/ExecStart/.test(dropIn), 'the drop-in must not change what is executed');
  assert.ok(!/ListenStream|Sockets=/.test(dropIn));
  assert.ok(!/PrivateNetwork=no/.test(dropIn));
});

// ── the manual tells the truth about all of this ────────────────────────────

test('the manual documents the two-step enablement and its consequence', () => {
  const manual = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs/manual/OS-LEVEL-LINUX-HOST-CONTROL.md'), 'utf8');
  assert.match(manual, /packagesEnabled.*기본 false|기본 false.*packagesEnabled/s);
  assert.match(manual, /packageAllowlist/);
  assert.match(manual, /kernel\.update/);
  assert.match(manual, /절대 재부팅하지 않습니다/,
    'the manual must state that a kernel update does not reboot');
});

test('the private UTS namespace is kept, and the manual owns the consequence', () => {
  // ProtectHostname=yes gives the unit its own UTS namespace, so os.Hostname()
  // returns the name as it was when the service started. Rename a host with
  // hostnamectl and the reported hostname stays at the old value until the
  // agent restarts.
  //
  // This is accepted rather than fixed, because every read-only alternative is
  // worse. /proc/sys/kernel/hostname is that same namespace. /etc/hostname is
  // the configured name, not the running one, and differs legitimately wherever
  // DHCP or cloud-init sets a transient hostname — comparing the two would put
  // a false entry in the degraded list on hosts where nothing is wrong, and the
  // degraded list is only worth having if everything in it is real. Dropping
  // the directive would trade a display inaccuracy for a weaker sandbox.
  //
  // The exposure is bounded: hosts are identified by their enrolment hostId,
  // never by this string, so a stale value misreports a label and nothing else.
  assert.deepEqual(directives(unit, 'ProtectHostname'), ['yes'],
    'dropping this to freshen a display string would widen the sandbox for every host');

  const manual = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs/manual/OS-LEVEL-LINUX-HOST-CONTROL.md'), 'utf8');
  assert.match(manual, /ProtectHostname/,
    'a known-stale field must be documented, not left for an operator to discover');
  assert.match(manual, /hostnamectl/);
});

// ── Stage 4: three separate authorities, three separate drop-ins ────────────
//
// The three Stage 4 authorities need different widenings and none implies
// another. Bundling them into one file would mean granting a host the ability
// to reconfigure its network in order to let it grow a filesystem.

const stage4DropIns = {
  network: fs.readFileSync(path.join(packagingDir, 'network-maintenance.conf'), 'utf8'),
  storage: fs.readFileSync(path.join(packagingDir, 'storage-maintenance.conf'), 'utf8'),
  osimage: fs.readFileSync(path.join(packagingDir, 'osimage-maintenance.conf'), 'utf8'),
};

/**
 * Prose in these files is wrapped and comment-prefixed. Assertions are about
 * what a file says, not about where its line breaks fall, so they run against a
 * flattened copy.
 */
function prose(body) {
  return body.replace(/^#\s?/gm, '').replace(/\s+/g, ' ').trim();
}

test('every Stage 4 authority is a separate opt-in file', () => {
  const names = Object.keys(stage4DropIns);
  assert.equal(new Set(names).size, names.length);
  for (const [name, body] of Object.entries(stage4DropIns)) {
    assert.ok(!unit.includes(`${name}-maintenance`),
      `${name} must not be pulled in by the base unit`);
    // A drop-in that granted a neighbouring authority would defeat the point of
    // separating them.
    assert.ok(!/ExecStart/.test(body), `${name} must not change what is executed`);
    assert.ok(!/ListenStream|Sockets=|PrivateNetwork=no/.test(body),
      `${name} must not open an inbound path`);
  }
});

test('the shipped configuration enables no Stage 4 authority', () => {
  // Installing a build that can reconfigure a network must not by itself make a
  // host reconfigurable.
  for (const key of ['networkEnabled', 'storageEnabled', 'osImageEnabled']) {
    assert.equal(exampleConfig[key], false, `${key} must ship off`);
  }
  for (const key of ['networkAllowlist', 'storageMountRoots', 'storageGrowAllowlist', 'osImageAllowlist']) {
    assert.deepEqual(exampleConfig[key], [], `${key} must ship empty`);
  }
  // Reporting changes nothing, so inventory ships on.
  for (const key of ['collectNetworkState', 'collectStorage', 'collectBoot']) {
    assert.equal(exampleConfig[key], true, `${key} must ship on`);
  }
});

test('the network drop-in grants only what changing an address needs', () => {
  const caps = directives(stage4DropIns.network, 'CapabilityBoundingSet');
  assert.equal(caps.length, 1);
  const granted = caps[0].split(/\s+/).filter(Boolean).sort();
  assert.deepEqual(granted, ['CAP_NET_ADMIN', 'CAP_SYS_BOOT'].sort(),
    'reconfiguring a link needs CAP_NET_ADMIN and nothing else');
  // Nothing in the agent sends raw packets, and mounting is a different
  // authority entirely.
  for (const dangerous of ['CAP_NET_RAW', 'CAP_SYS_ADMIN', 'CAP_SYS_MODULE', 'CAP_SYS_PTRACE']) {
    assert.ok(!granted.includes(dangerous), `${dangerous} is not needed to change an address`);
  }
  // Only NetworkManager's own profile store becomes writable.
  assert.deepEqual(directives(stage4DropIns.network, 'ReadWritePaths'), ['/etc/NetworkManager']);
});

test('the storage drop-in grants the growth ioctls and says which is widest', () => {
  const caps = directives(stage4DropIns.storage, 'CapabilityBoundingSet')[0].split(/\s+/);
  // The agent never calls mount(2): it writes a unit and asks PID 1 to start it.
  // What it does issue directly is the online-grow ioctl, and those two
  // filesystems check two different capabilities.
  assert.ok(caps.includes('CAP_SYS_ADMIN'), 'xfs_growfs needs it');
  assert.ok(caps.includes('CAP_SYS_RESOURCE'), 'ext4 online resize needs it');
  assert.ok(caps.includes('CAP_SYS_BOOT'), 'host.reboot is still a declared operation');
  assert.match(prose(stage4DropIns.storage), /widest capability any Stage 4 authority grants/,
    'the file must say plainly that this is the widest grant');
});

test('no drop-in relaxes the read-only filesystem wholesale', () => {
  // ProtectSystem=full would make all of /var, /srv, /mnt and /opt writable in
  // one line, which is a far wider grant than the enumerated ReadWritePaths it
  // sits beside — and it silently supersedes them.
  for (const [name, body] of Object.entries({ ...stage4DropIns, package: dropIn })) {
    assert.deepEqual(directives(body, 'ProtectSystem'), [],
      `${name} must inherit ProtectSystem=strict rather than relax it`);
  }
});

test('a drop-in never tries to widen the syscall filter with a deny list', () => {
  // systemd merges SystemCallFilter across drop-ins, and a `~` list only ever
  // subtracts from what is already allowed. A deny list in a drop-in therefore
  // cannot restore a group the base unit denied: it reads like a grant and does
  // nothing. Re-permitting a group requires a positive entry, so any `~` here is
  // either a no-op or a mistake about which way the merge runs.
  for (const [name, body] of Object.entries({ ...stage4DropIns, package: dropIn })) {
    for (const value of directives(body, 'SystemCallFilter')) {
      assert.ok(!value.startsWith('~'),
        `${name} uses a deny list, which cannot grant the syscalls it appears to: ${value}`);
    }
  }
});

test('every drop-in says that installing another widens it too', () => {
  // Each file claims to be narrowly scoped. That is true of the authority and
  // false of the sandbox, because systemd unions list-valued settings across
  // drop-ins, and an operator reading one file must not be left with the wrong
  // model of what installing two of them does.
  for (const [name, body] of Object.entries({ ...stage4DropIns, package: dropIn })) {
    assert.match(prose(body), /union across every drop-in installed|union of both|union of all of them/,
      `${name} must state that drop-ins union rather than isolate`);
  }
});

test('the storage drop-in states what cannot be expressed at all', () => {
  // The strongest guarantee here is not a runtime refusal but the absence of a
  // field, and the file that grants the authority is the right place to say so.
  const text = prose(stage4DropIns.storage);
  for (const claim of [
    /formats a filesystem/,
    /writes a partition table/,
    /shrinks anything/,
    /edits \/etc\/fstab/,
    /cannot be expressed/,
  ]) {
    assert.match(text, claim);
  }
});

test('the image drop-in states that staging never reboots', () => {
  const text = prose(stage4DropIns.osimage);
  assert.match(text, /Neither operation reboots, and neither can be asked to/);
  assert.match(text, /digest-pinned/);
  assert.match(text, /RESIDUAL RISK/);
  // The honest limit of what this platform verifies about somebody else's OS.
  assert.match(text, /not that the contents of that digest are safe/);
});

test('every Stage 4 drop-in explains the fail-closed default', () => {
  for (const [name, body] of Object.entries(stage4DropIns)) {
    const text = prose(body);
    assert.match(text, /a deliberate, separate act/, `${name} must explain why it is separate`);
    assert.match(text, /three things a person has to do on purpose/,
      `${name} must state the three deliberate steps`);
  }
  // network and storage additionally say what happens without them; the image
  // drop-in applies only to hosts that are image-based at all.
  for (const name of ['network', 'storage']) {
    assert.match(prose(stage4DropIns[name]), /fails closed/, `${name} must state the safe default`);
  }
});

test('the installer names each authority, its allowlist and its drop-in', () => {
  for (const fragment of [
    'networkEnabled + networkAllowlist',
    'storageMountRoots and/or storageGrowAllowlist',
    'osImageEnabled + osImageAllowlist',
    'network-maintenance.conf',
    'storage-maintenance.conf',
    'osimage-maintenance.conf',
  ]) {
    assert.ok(installer.includes(fragment), `the installer must mention ${fragment}`);
  }
  assert.match(installer, /three SEPARATE/,
    'an operator must be told these are not one switch');
  assert.match(installer, /the tool fails and the operation fails closed/);
});

test('the base unit is unchanged by the Stage 4 authorities', () => {
  // Every widening lives in a drop-in. A host with the binary and no drop-in
  // keeps exactly the sandbox Stage 2 established.
  assert.deepEqual(directives(unit, 'ProtectSystem'), ['strict']);
  assert.deepEqual(directives(unit, 'CapabilityBoundingSet'), ['CAP_SYS_BOOT']);
  assert.deepEqual(directives(unit, 'ReadWritePaths'), ['/var/lib/rcc-node-agent']);
  for (const path of ['/etc/NetworkManager', '/srv', '/mnt', '/sysroot', '/ostree']) {
    assert.ok(!unit.includes(path), `${path} must not appear in the base unit`);
  }
});

test('the manual documents the Stage 4 authorities and their honest limits', () => {
  const manual = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs/manual/OS-LEVEL-LINUX-HOST-CONTROL.md'), 'utf8');
  for (const fragment of [
    'network.configure', 'mount.configure', 'filesystem.grow',
    'osimage.stage', 'osimage.rollback',
    'network-maintenance.conf', 'storage-maintenance.conf', 'osimage-maintenance.conf',
    'rollback-failed', 'not-recorded',
  ]) {
    assert.ok(manual.includes(fragment), `the manual must document ${fragment}`);
  }
  // The statement the user is entitled to: nothing was exercised live.
  assert.match(manual, /CC2에 배포하지 않았습니다/);
  assert.match(manual, /살아 있는 불변 OS 호스트를 상대로 검증하지는 않았습니다/);
  assert.match(manual, /재부팅을 수행하지 않았습니다/);
  // And the Stage 3 limitation is still stated rather than quietly dropped.
  assert.match(manual, /Gitea 선언적 정책 조정은 Stage 3에서와 마찬가지로 \*\*여전히 구현되어 있지 않습니다\*\*/);
});
