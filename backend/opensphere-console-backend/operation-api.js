'use strict';

/**
 * Governed typed host operations.
 *
 * Two audiences, one state machine:
 *
 *   operators  authenticate with a Supabase session, request and review work
 *   agents     authenticate with a host-bound HMAC key, collect and report work
 *
 * Neither is trusted for anything the other controls. An operator cannot set a
 * state; they can only ask for a transition the database will re-check. An
 * agent cannot choose which operation to run; it receives exactly one plan
 * bound to its own host and attempt.
 *
 * Every authority decision is re-derived server-side from the session and the
 * database. Nothing in a request body ever names the requester, the approver,
 * or a target state.
 */

const crypto = require('crypto');
const net = require('net');
const { verifyAgentRequest, planResponseHeaders, MAX_BODY_BYTES } = require('./agent-signature');

const PLAN_SCHEMA_VERSION = 'rcc.host.plan/v1';
const RECEIPT_SCHEMA_VERSION = 'rcc.host.receipt/v1';

const OPERATION_ROUTE_RE =
  /^\/api\/control-centers\/([^/]+)\/hosts\/([^/]+)\/operations(?:\/([a-z]+))?$/;
const OPERATION_ITEM_ROUTE_RE =
  /^\/api\/control-centers\/([^/]+)\/operations\/([0-9a-f-]{36})(?:\/([a-z]+))?$/;
const PLUGIN_API_NAMESPACE = '/api/plugins/linux-host-manager';

const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Mirrors the agent's unitRe (internal/plan/plan.go) exactly. Each dot-segment
// must start alphanumeric, so `foo..service` is not a name; an `@` instance
// suffix is allowed, so `getty@tty1.service` is. Divergence in either direction
// is a defect: a name the backend accepts and the agent refuses becomes an
// operation that is approved and can never run, and a name the agent accepts
// and the backend does not is a gap in what can be reviewed.
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*(@[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?\.(service|socket|timer|target|path|mount)$/;
const TIME_SPEC_RE = /^(\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?|-?\d{1,4} (second|minute|hour|day)s? ago|now|today|yesterday)$/;
const CURSOR_RE = /^[A-Za-z0-9;=_:.-]{0,512}$/;
const CONTROL_CHARS_TEST = /[\u0000-\u001f\u007f]/;

const PRIORITIES = new Set(['', 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']);

// Stage 3. These mirror the agent's grammar byte for byte: a name the backend
// accepts but the agent refuses would produce an operation that can never run,
// and a name the agent accepts but the backend does not would be a gap.
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9+.-]{1,127}$/;
const PACKAGE_VERSION_RE = /^([0-9]{1,4}:)?[0-9][A-Za-z0-9.+~-]{0,127}$/;
const KERNEL_RELEASE_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?(-[a-z0-9]{1,32})*$/;
const SUPPORTED_PACKAGE_MANAGER = 'apt';
const KERNEL_IMAGE_PREFIX = 'linux-image-';
const MAX_UPDATE_PACKAGES = 32;

// Stage 4. Every one of these mirrors the agent's grammar exactly, for the same
// reason the Stage 3 ones do: a value the backend accepts and the agent refuses
// produces an operation that can never run, and a value the agent accepts and
// the backend does not is a gap in review.
const CONNECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const INTERFACE_NAME_RE = /^[a-z][a-z0-9_.-]{0,14}$/;
const IPV4_RE = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const IPV4_CIDR_RE = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\/([0-9]|[12][0-9]|3[0-2])$/;
const SEARCH_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MOUNT_PATH_RE = /^(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,62}){1,8}$/;
const FS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PINNED_IMAGE_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?){1,6}@sha256:[0-9a-f]{64}$/;

const NETWORK_ADAPTER = 'NetworkManager';
const STORAGE_ADAPTER = 'systemd-mount';
const IMAGE_ADAPTERS = new Set(['rpm-ostree', 'bootc']);
const SSH_PROTECTION_PROFILE = 'rcc-ssh-baseline-v1';
const SSH_PROTECTION_DRIFT = `${SSH_PROTECTION_PROFILE}-drift`;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MOUNTABLE_FS_TYPES = new Set(['ext4', 'xfs']);
const MAX_LINK_ADDRESSES = 4;
const MAX_LINK_DNS = 4;
const MAX_SEARCH_DOMAINS = 8;
const MIN_MTU = 1280;
const MAX_MTU = 9216;
const MIN_ROLLBACK_SECONDS = 30;
const MAX_ROLLBACK_SECONDS = 600;
const DEFAULT_ROLLBACK_SECONDS = 120;

/** Operations whose adapter is fixed by the operation itself. */
const OPERATION_ADAPTER = {
  'network.configure': NETWORK_ADAPTER,
  'mount.configure': STORAGE_ADAPTER,
  'filesystem.grow': STORAGE_ADAPTER,
};

/** Operations the platform must be able to undo by itself. */
const ROLLBACK_OPERATIONS = new Set(['network.configure']);

const MAX_REASON = 500;
const MIN_REASON = 8;
const MAX_LIST = 100;
const MAX_POLL_WAIT_SECONDS = 25;
const PLAN_LIFETIME_SECONDS = 600;
// How long a `preparing` claim may go quiet before another poll takes it over.
// Long enough that a slow drain is never interrupted, short enough that a lost
// process does not strand the operation or leave a node cordoned.
const PREPARE_STALE_MS = 15 * 60 * 1000;
// Statuses whose event can be re-derived from the row alone.
const EVENT_BEARING_STATUSES = new Set(['leased', 'running', 'succeeded', 'failed']);
const EVENT_RECONCILE_LIMIT = 5;
// Automatic recovery of a cordoned node is bounded. Past this the platform
// stops pretending it can fix it and says so, rather than retrying quietly
// forever while the node stays out of service.
const MAX_RECOVERY_ATTEMPTS = 10;
// Receipts arrive over the signed agent channel, which is bounded at 64 KiB.
// Keeping this identical means the backend never accepts something the agent
// could not have sent, and never rejects something it could.
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RECEIPT_OUTPUT = 48 * 1024;

/** Per-operation lease budget, mirroring console.host_operation_type. */
const LEASE_SECONDS = {
  'journal.query': 120,
  'service.restart': 300,
  'host.reboot': 900,
  'package.refresh': 300,
  'package.update': 1800,
  'kernel.update': 1800,
  // Stage 4. The network lease covers the rollback window plus the confirmation
  // attempts inside it, so a change that is rolled back still reports before its
  // lease expires.
  'network.configure': 900,
  'mount.configure': 600,
  'filesystem.grow': 1800,
  // Pulling an operating system image is slow on any link worth having.
  'osimage.stage': 3600,
  'osimage.rollback': 600,
  'ssh.protection.enable': 1800,
  'ssh.ban': 120,
  'ssh.unban': 120,
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function digestOf(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Canonical JSON: object keys sorted at every level.
 *
 * The content digest must not change because a client serialised the same
 * parameters in a different key order, or an approval would spuriously
 * invalidate.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

/**
 * The digest an approval binds.
 *
 * Changing the operation or its parameters changes it, which is what makes an
 * edited request lose its approval. From Stage 3 the governing policy version
 * is part of it too: work reviewed under one set of maintenance rules must not
 * execute under another, even when the packages are identical.
 *
 * An ungoverned operation passes no policy and hashes exactly as it did before
 * Stage 3, so existing approvals are unaffected.
 */
function contentDigest(operation, parameters, policy = null) {
  const document = { operation, parameters };
  if (policy) {
    document.policy = { policyId: policy.policyId, policyVersion: Number(policy.policyVersion) };
  }
  return digestOf(JSON.stringify(canonicalize(document)));
}

function boundedReason(value) {
  const reason = String(value ?? '').trim();
  if (CONTROL_CHARS_TEST.test(reason)) throw { code: 400, msg: 'reason contains control characters' };
  if (reason.length < MIN_REASON) throw { code: 400, msg: `reason must be at least ${MIN_REASON} characters` };
  if (reason.length > MAX_REASON) throw { code: 400, msg: `reason exceeds ${MAX_REASON} characters` };
  return reason;
}

/**
 * Validates and re-projects operation parameters.
 *
 * The stored parameters are built field by field from an allowlist rather than
 * taken from the request, so an operator cannot smuggle an extra field into
 * something an approver will later review.
 */
function normalizeParameters(operation, raw, context = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  switch (operation) {
    case 'network.configure':
      return normalizeNetworkConfigure(input, context);
    case 'mount.configure':
      return normalizeMountConfigure(input, context);
    case 'filesystem.grow':
      return normalizeFilesystemGrow(input, context);
    case 'osimage.stage':
    case 'osimage.rollback':
      return normalizeOSImage(operation, input, context);
    case 'ssh.ban':
    case 'ssh.unban':
      return normalizeSSHBan(operation, input, context);
    case 'ssh.protection.enable':
      return normalizeSSHProtection(input, context);
    case 'journal.query': {
      const units = Array.isArray(input.units) ? input.units : [];
      if (units.length > 8) throw { code: 400, msg: 'at most 8 units may be queried' };
      for (const unit of units) {
        if (typeof unit !== 'string' || !UNIT_RE.test(unit)) {
          throw { code: 400, msg: `unit ${String(unit).slice(0, 64)} is not a valid systemd unit name` };
        }
      }
      const priority = String(input.priority ?? '');
      if (!PRIORITIES.has(priority)) throw { code: 400, msg: 'priority is not a journald priority' };
      for (const [name, value] of [['since', input.since], ['until', input.until]]) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string' || !TIME_SPEC_RE.test(value)) {
          throw { code: 400, msg: `${name} is not an accepted time specification` };
        }
      }
      const cursor = String(input.cursor ?? '');
      if (!CURSOR_RE.test(cursor)) throw { code: 400, msg: 'cursor is malformed' };
      const lines = Number(input.lines ?? 200);
      if (!Number.isInteger(lines) || lines < 1 || lines > 2000) {
        throw { code: 400, msg: 'lines must be an integer 1..2000' };
      }
      return {
        units,
        priority,
        since: String(input.since ?? ''),
        until: String(input.until ?? ''),
        cursor,
        lines,
      };
    }
    case 'service.restart': {
      const unit = String(input.unit ?? '');
      // The agent applies the same two rules in the same order: the shared unit
      // grammar, then the restriction to .service for restart specifically.
      if (!UNIT_RE.test(unit) || !unit.endsWith('.service')) {
        throw { code: 400, msg: 'unit must be a plain .service name' };
      }
      return { unit };
    }
    case 'host.reboot': {
      const deadlineSeconds = Number(input.deadlineSeconds ?? 600);
      if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 60 || deadlineSeconds > 1800) {
        throw { code: 400, msg: 'deadlineSeconds must be an integer 60..1800' };
      }
      return { deadlineSeconds };
    }
    case 'package.refresh': {
      const manager = String(input.manager ?? SUPPORTED_PACKAGE_MANAGER);
      if (manager !== SUPPORTED_PACKAGE_MANAGER) {
        throw { code: 400, msg: `package manager ${manager.slice(0, 32)} is not supported` };
      }
      return { manager };
    }
    case 'package.update': {
      const manager = String(input.manager ?? SUPPORTED_PACKAGE_MANAGER);
      if (manager !== SUPPORTED_PACKAGE_MANAGER) {
        throw { code: 400, msg: `package manager ${manager.slice(0, 32)} is not supported` };
      }
      const raw = Array.isArray(input.packages) ? input.packages : [];
      if (raw.length === 0) {
        // There is deliberately no "everything" form: a set nobody enumerated
        // is a set nobody reviewed, and its contents change with the mirror.
        throw { code: 400, msg: 'at least one package must be named' };
      }
      if (raw.length > MAX_UPDATE_PACKAGES) {
        throw { code: 400, msg: `at most ${MAX_UPDATE_PACKAGES} packages may be updated in one operation` };
      }
      const seen = new Set();
      const packages = [];
      for (const entry of raw) {
        const source = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? entry : { name: entry };
        const name = String(source.name ?? '');
        if (!PACKAGE_NAME_RE.test(name)) {
          throw { code: 400, msg: `package ${name.slice(0, 64)} is not a valid Debian package name` };
        }
        if (name.startsWith(KERNEL_IMAGE_PREFIX)) {
          throw { code: 400, msg: `${name} is a kernel image; request kernel.update instead` };
        }
        const version = String(source.version ?? '');
        if (!PACKAGE_VERSION_RE.test(version)) {
          throw {
            code: 400,
            msg: version === ''
              ? `package ${name} must pin the exact candidate version shown to the approver`
              : `version ${version.slice(0, 64)} is malformed`,
          };
        }
        if (seen.has(name)) throw { code: 400, msg: `package ${name} is named twice` };
        seen.add(name);
        packages.push({ name, version });
      }
      // Sorted once, here, so the same set requested in a different order is
      // the same approved content rather than a second thing to review.
      packages.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      return { manager, packages, securityOnly: input.securityOnly === true };
    }
    case 'kernel.update': {
      const manager = String(input.manager ?? SUPPORTED_PACKAGE_MANAGER);
      if (manager !== SUPPORTED_PACKAGE_MANAGER) {
        throw { code: 400, msg: `package manager ${manager.slice(0, 32)} is not supported` };
      }
      const targetRelease = String(input.targetRelease ?? '');
      if (!KERNEL_RELEASE_RE.test(targetRelease)) {
        throw {
          code: 400,
          msg: targetRelease === ''
            ? 'kernel.update must pin the exact candidate release shown to the approver'
            : `kernel release ${targetRelease.slice(0, 64)} is malformed`,
        };
      }
      // rebootAfter is not a parameter. A kernel update never reboots, and
      // accepting the field at all would suggest otherwise.
      if (input.rebootAfter !== undefined) {
        throw { code: 400, msg: 'kernel.update never reboots; rebootAfter is not accepted' };
      }
      return { manager, targetRelease };
    }
    default:
      throw { code: 400, msg: `unknown operation ${String(operation).slice(0, 64)}` };
  }
}

function canonicalIPAddress(value) {
  const address = String(value ?? '').trim();
  const family = net.isIP(address);
  if (family === 4) return address.split('.').map((part) => String(Number(part))).join('.');
  if (family === 6) {
    try {
      const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
      if (!mapped) return canonical;
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    } catch {
      return '';
    }
  }
  return '';
}

function unsafeBanTarget(address) {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || octets[0] >= 224;
  }
  return address === '::' || address === '::1'
    || address.startsWith('ff')
    || /^(fe[89ab])/.test(address);
}

function normalizeSSHBan(operation, input, context) {
  const snapshot = requireSnapshot(context, operation);
  const state = snapshot.sshBan || {};
  const operations = snapshot.operations || {};
  if (state.provider !== 'fail2ban' || state.jail !== 'sshd'
      || state.supported !== true || state.active !== true) {
    throw { code: 409, msg: state.unsupportedReason || 'the Fail2ban sshd jail is not active on this host' };
  }
  if (operations.sshBanEnabled !== true) {
    throw { code: 409, msg: 'the agent on this host has not been given SSH ban operations' };
  }
  const address = canonicalIPAddress(input.address);
  if (!address) throw { code: 400, msg: 'address must be one exact IP address; CIDR ranges are not accepted' };
  const banned = new Set(
    (Array.isArray(state.bannedAddresses) ? state.bannedAddresses : [])
      .map(canonicalIPAddress).filter(Boolean),
  );
  const protectedAddresses = new Set(
    (Array.isArray(operations.sshProtectedAddresses) ? operations.sshProtectedAddresses : [])
      .map(canonicalIPAddress).filter(Boolean),
  );
  if (operation === 'ssh.ban') {
    if (unsafeBanTarget(address)) {
      throw { code: 400, msg: 'unspecified, loopback, multicast and link-local addresses cannot be banned' };
    }
    if (protectedAddresses.has(address)) {
      throw { code: 409, msg: 'that address is protected by this host and cannot be banned' };
    }
    if (banned.has(address)) throw { code: 409, msg: 'that address is already banned; refresh the host view' };
    return { jail: 'sshd', address, expectedBanned: false };
  }
  if (!banned.has(address)) throw { code: 409, msg: 'that address is no longer banned; refresh the host view' };
  return { jail: 'sshd', address, expectedBanned: true };
}

function normalizeSSHProtection(input, context) {
  if (Object.keys(input).length > 0) {
    throw { code: 400, msg: 'ssh.protection.enable accepts no operator-supplied policy fields' };
  }
  const snapshot = requireSnapshot(context, 'ssh.protection.enable');
  const state = snapshot.sshBan || {};
  const operations = snapshot.operations || {};
  if (state.provider !== 'fail2ban' || state.jail !== 'sshd') {
    throw { code: 409, msg: 'this host does not report the fixed Fail2ban sshd protection provider' };
  }
  if (operations.sshBanEnabled !== true) {
    throw { code: 409, msg: 'the agent on this host has not enabled SSH protection operations' };
  }
  const protectedAddresses = [...new Set(
    (Array.isArray(operations.sshProtectedAddresses) ? operations.sshProtectedAddresses : [])
      .map(canonicalIPAddress)
      .filter(Boolean),
  )].sort();
  if (protectedAddresses.length === 0) {
    throw { code: 409, msg: 'the host must declare at least one protected management address' };
  }
  const expectedInstalled = state.installed === true;
  const packageVersion = String(
    expectedInstalled ? (state.packageVersion || '') : (state.candidateVersion || ''),
  );
  if (!PACKAGE_VERSION_RE.test(packageVersion)) {
    throw {
      code: 409,
      msg: expectedInstalled
        ? 'the host does not report its exact installed Fail2ban version'
        : 'the host does not report an exact installable Fail2ban candidate version',
    };
  }
  const observedProfile = String(state.protectionProfile || '');
  if (observedProfile === 'external') {
    throw {
      code: 409,
      msg: 'the fixed RCC profile path contains external policy and will not be overwritten',
    };
  }
  if (state.active === true && observedProfile === SSH_PROTECTION_PROFILE) {
    throw { code: 409, msg: 'the active Fail2ban sshd jail already matches the RCC protection baseline' };
  }
  if (state.active === true && observedProfile !== SSH_PROTECTION_DRIFT) {
    throw {
      code: 409,
      msg: 'the active Fail2ban sshd jail is not owned by the RCC protection baseline',
    };
  }
  const expectedProfileDigest = String(state.profileDigest || '');
  if (observedProfile && !SHA256_DIGEST_RE.test(expectedProfileDigest)) {
    throw { code: 409, msg: 'the host does not report the exact digest of its existing RCC profile' };
  }
  return {
    provider: 'fail2ban',
    jail: 'sshd',
    profile: SSH_PROTECTION_PROFILE,
    packageVersion,
    expectedProfileDigest,
    expectedInstalled,
    expectedActive: state.active === true,
    protectedAddresses,
  };
}

// ── Stage 4 parameter normalisation ─────────────────────────────────────────
//
// These differ from Stage 1–3 in one important way: the stored parameters carry
// the *observed pre-state*, and it is derived here from the host's own reported
// inventory rather than taken from the request.
//
// That is what makes "the host changed since you reviewed this" a detectable
// condition. The pre-state enters the content digest, so it is part of what an
// approver binds; the agent re-checks it against live state before acting; and
// a host that was reconfigured by hand in between is refused rather than having
// a reviewed change layered on top of an unknown starting point.

/** The reported snapshot, or a refusal. Stage 4 cannot be requested blind. */
function requireSnapshot(context, operation) {
  const snapshot = context?.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    throw {
      code: 409,
      msg: `${operation} needs this host's current state and it has not reported a snapshot yet`,
    };
  }
  return snapshot;
}

function boundedList(value, limit) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > limit) throw { code: 400, msg: `at most ${limit} entries are accepted` };
  return list.map((entry) => String(entry ?? ''));
}

/**
 * What the host's own agent has been configured to accept.
 *
 * The agent enforces these allowlists itself and refuses anything outside them.
 * Checking here as well is not redundancy for its own sake: without it a request
 * clears permission, assurance, two-person approval, policy and the maintenance
 * window, gets dispatched, and only then fails on the host — after everyone
 * involved has been told it was authorised. `service.restart` already
 * intersects the two lists this way, and these are the same thing for the
 * Stage 4 authorities.
 */
function agentAllowlist(snapshot, key) {
  const operations = snapshot?.operations;
  const list = operations && typeof operations === 'object' ? operations[key] : null;
  return Array.isArray(list) ? list.map((entry) => String(entry ?? '')) : [];
}

/** Mirrors guard.Normalize in the agent: clean the path, drop a trailing slash. */
function normalizePath(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return '';
  const absolute = trimmed.startsWith('/');
  const segments = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  if (absolute) return joined === '' ? '/' : `/${joined}`;
  return joined === '' ? '.' : joined;
}

/** Mirrors guard.UnderRoot: strictly beneath, and never the root itself. */
function underRoot(candidate, root) {
  const c = normalizePath(candidate);
  const r = normalizePath(root);
  if (c === '' || r === '' || c === r) return false;
  // Verbatim: for the root itself this is a prefix of "//" and so is false,
  // which is what the agent does and why "/" is never a usable mount root.
  return c.startsWith(`${r}/`);
}

function refuseUnlessAgentAllows(allowed, target, what) {
  if (allowed) return;
  throw {
    code: 409,
    msg: `this host's agent is not configured to ${what} ${target}`,
  };
}

function normalizeNetworkConfigure(input, context) {
  const snapshot = requireSnapshot(context, 'network.configure');
  const state = snapshot.networkState || {};
  if (state.supported !== true) {
    throw {
      code: 409,
      msg: state.unsupportedReason
        || 'this host does not report a network stack this platform can reconfigure',
    };
  }

  const connection = String(input.connection ?? '');
  if (!CONNECTION_NAME_RE.test(connection)) {
    throw { code: 400, msg: 'connection must be a NetworkManager profile name' };
  }
  refuseUnlessAgentAllows(
    agentAllowlist(snapshot, 'networkAllowlist').includes(connection),
    `the connection "${connection}"`, 'reconfigure');
  const iface = String(input.interface ?? '');
  if (!INTERFACE_NAME_RE.test(iface)) throw { code: 400, msg: 'interface is not a valid interface name' };

  const links = Array.isArray(state.links) ? state.links : [];
  const link = links.find((entry) => entry.name === iface);
  if (!link) throw { code: 409, msg: `this host does not report an interface named ${iface}` };
  if (link.managed !== true) {
    throw { code: 409, msg: `NetworkManager does not manage ${iface} on this host` };
  }
  if (link.connection && link.connection !== connection) {
    throw { code: 409, msg: `${iface} is carried by connection "${link.connection}", not "${connection}"` };
  }

  const defaultRoute = state.defaultRoute || {};
  const managementLink = defaultRoute.present === true ? String(defaultRoute.interface || '') : '';
  if (managementLink && managementLink === iface) {
    // Refused here, again by the agent against live state, and again by the
    // grammar. This is the interface the control center is reached through.
    throw {
      code: 409,
      msg: `${iface} carries the default route to this control center and is never reconfigured by this platform`,
    };
  }

  const method = String(input.method ?? '');
  if (method !== 'auto' && method !== 'manual') {
    throw { code: 400, msg: 'method must be auto or manual' };
  }

  const addresses = boundedList(input.addresses, MAX_LINK_ADDRESSES);
  const seen = new Set();
  for (const address of addresses) {
    if (!IPV4_CIDR_RE.test(address)) {
      throw { code: 400, msg: `address ${address.slice(0, 64)} must be an IPv4 address with a prefix length` };
    }
    if (seen.has(address)) throw { code: 400, msg: `address ${address} is listed twice` };
    seen.add(address);
  }
  const gateway = String(input.gateway ?? '');
  if (gateway !== '' && !IPV4_RE.test(gateway)) {
    throw { code: 400, msg: 'gateway must be an IPv4 address' };
  }
  if (method === 'manual' && addresses.length === 0) {
    throw { code: 400, msg: 'a manual configuration must carry at least one address' };
  }
  if (method === 'auto' && (addresses.length > 0 || gateway !== '')) {
    // Otherwise the stored parameters describe one thing and the host does
    // another, and the receipt could not be read against the request.
    throw { code: 400, msg: 'an automatic configuration must not also carry static addresses or a gateway' };
  }

  const dns = boundedList(input.dns, MAX_LINK_DNS);
  for (const server of dns) {
    if (!IPV4_RE.test(server)) throw { code: 400, msg: `DNS server ${server.slice(0, 64)} must be an IPv4 address` };
  }
  const searchDomains = boundedList(input.searchDomains, MAX_SEARCH_DOMAINS);
  for (const domain of searchDomains) {
    if (!SEARCH_DOMAIN_RE.test(domain) || domain.length > 253) {
      throw { code: 400, msg: `search domain ${domain.slice(0, 64)} is malformed` };
    }
  }

  // The snapshot may carry more static addresses than a plan can express. The
  // agent compares the recorded set to the live one as a whole, so a truncated
  // pre-state would not merely be incomplete, it would never match — the
  // operation would be approved and then refused on the host every time. Saying
  // so here is the honest answer.
  const reportedStatic = Array.isArray(link.staticAddresses) ? link.staticAddresses : [];
  if (reportedStatic.length > MAX_LINK_ADDRESSES) {
    throw {
      code: 409,
      msg: `${iface} has ${reportedStatic.length} static addresses and this platform reconfigures profiles with at most ${MAX_LINK_ADDRESSES}`,
    };
  }
  const staticAddresses = reportedStatic.map(String);

  const mtu = Number(input.mtu ?? 0);
  if (!Number.isInteger(mtu) || (mtu !== 0 && (mtu < MIN_MTU || mtu > MAX_MTU))) {
    throw { code: 400, msg: `mtu must be 0 (unchanged) or an integer ${MIN_MTU}..${MAX_MTU}` };
  }
  const rollbackSeconds = Number(input.rollbackSeconds ?? DEFAULT_ROLLBACK_SECONDS);
  if (!Number.isInteger(rollbackSeconds)
    || rollbackSeconds < MIN_ROLLBACK_SECONDS || rollbackSeconds > MAX_ROLLBACK_SECONDS) {
    // There is no "no rollback" value. A network change this platform cannot
    // undo is one it does not make.
    throw { code: 400, msg: `rollbackSeconds must be an integer ${MIN_ROLLBACK_SECONDS}..${MAX_ROLLBACK_SECONDS}` };
  }

  return {
    adapter: NETWORK_ADAPTER,
    connection,
    interface: iface,
    method,
    addresses,
    gateway,
    dns,
    searchDomains,
    mtu,
    rollbackSeconds,
    // NetworkManager's own ipv4 settings, which is what the agent compares
    // against. The kernel's address list would include a DHCP lease and would
    // therefore never match.
    preState: {
      method: String(link.method || ''),
      addresses: staticAddresses,
      gateway: String(link.gateway || ''),
      mtu: Number.isInteger(link.mtu) ? link.mtu : 0,
      defaultRouteInterface: managementLink,
    },
  };
}

function normalizeMountConfigure(input, context) {
  const snapshot = requireSnapshot(context, 'mount.configure');
  const storage = snapshot.storage || {};
  if (storage.supported !== true) {
    throw {
      code: 409,
      msg: storage.unsupportedReason || 'this host does not report a block layer this platform can read',
    };
  }

  const filesystemUuid = String(input.filesystemUuid ?? '').toLowerCase();
  if (!FS_UUID_RE.test(filesystemUuid)) throw { code: 400, msg: 'filesystemUuid is malformed' };
  const mountPoint = String(input.mountPoint ?? '');
  if (!MOUNT_PATH_RE.test(mountPoint)) throw { code: 400, msg: 'mountPoint is not an accepted absolute path' };

  const devices = Array.isArray(storage.devices) ? storage.devices : [];
  const device = devices.find((entry) => String(entry.uuid || '').toLowerCase() === filesystemUuid);
  if (!device) {
    throw { code: 409, msg: 'this host reports no filesystem with that uuid' };
  }
  if (device.protected === true) {
    throw { code: 409, msg: `${device.name} is protected and is never mounted by this platform` };
  }
  const fsType = String(input.fsType ?? device.fsType ?? '');
  if (!MOUNTABLE_FS_TYPES.has(fsType)) {
    throw { code: 400, msg: `filesystem type ${fsType.slice(0, 32)} is not one this platform mounts` };
  }
  if (device.fsType && device.fsType !== fsType) {
    throw { code: 409, msg: `that filesystem is ${device.fsType}, not ${fsType}` };
  }
  if (device.mountPoint && device.mountPoint !== mountPoint) {
    throw {
      code: 409,
      msg: `that filesystem is already mounted at ${device.mountPoint}; this operation does not move a mounted filesystem`,
    };
  }
  // Last, because what the target *is* is more useful to an operator than what
  // this host happens to be configured for.
  refuseUnlessAgentAllows(
    agentAllowlist(snapshot, 'mountRoots').some((root) => underRoot(mountPoint, root)),
    mountPoint, 'mount anything at');

  return {
    adapter: STORAGE_ADAPTER,
    filesystemUuid,
    mountPoint,
    fsType,
    readOnly: input.readOnly === true,
    // The remaining options default *on*: a data mount that nobody has argued
    // needs to execute binaries or honour setuid bits should not.
    noExec: input.noExec !== false,
    noSuid: input.noSuid !== false,
    noDev: input.noDev !== false,
    preState: {
      fsType,
      sizeBytes: Number.isFinite(Number(device.sizeBytes)) ? Math.trunc(Number(device.sizeBytes)) : 0,
      mountedAt: String(device.mountPoint || ''),
      deviceName: String(device.name || ''),
    },
  };
}

function normalizeFilesystemGrow(input, context) {
  const snapshot = requireSnapshot(context, 'filesystem.grow');
  const storage = snapshot.storage || {};
  if (storage.supported !== true) {
    throw {
      code: 409,
      msg: storage.unsupportedReason || 'this host does not report a block layer this platform can read',
    };
  }
  const mountPoint = String(input.mountPoint ?? '');
  if (!MOUNT_PATH_RE.test(mountPoint)) throw { code: 400, msg: 'mountPoint is not an accepted absolute path' };

  const capacity = Array.isArray(storage.capacity) ? storage.capacity : [];
  const entry = capacity.find((candidate) => candidate.mountPoint === mountPoint);
  if (!entry) throw { code: 409, msg: `this host reports no filesystem mounted at ${mountPoint}` };
  if (entry.protected === true) {
    throw { code: 409, msg: `${mountPoint} is protected and is never grown by this platform` };
  }
  if (entry.growable !== true) {
    // The reason travels with the refusal, because "cannot be grown" has
    // several very different causes and only one of them is a mistake.
    throw { code: 409, msg: entry.reason || `${mountPoint} cannot be grown` };
  }
  // Last, because what the target *is* is more useful to an operator than what
  // this host happens to be configured for.
  refuseUnlessAgentAllows(
    agentAllowlist(snapshot, 'growAllowlist').some((allowed) => normalizePath(allowed) === normalizePath(mountPoint)),
    mountPoint, 'grow');

  return {
    adapter: STORAGE_ADAPTER,
    mountPoint,
    // There is deliberately no target size. The filesystem is grown to the
    // device it already sits on and no further.
    preState: {
      device: String(entry.device || ''),
      fsType: String(entry.fsType || ''),
      sizeBytes: Math.trunc(Number(entry.sizeBytes) || 0),
      deviceBytes: Math.trunc(Number(entry.deviceBytes) || 0),
    },
  };
}

function normalizeOSImage(operation, input, context) {
  const snapshot = requireSnapshot(context, operation);
  const boot = snapshot.boot || {};
  if (boot.supported !== true) {
    throw {
      code: 409,
      msg: boot.unsupportedReason || 'this host does not take operating system updates as an image',
    };
  }
  const adapter = String(input.adapter ?? boot.adapter ?? '');
  if (!IMAGE_ADAPTERS.has(adapter)) {
    throw { code: 400, msg: `image adapter ${adapter.slice(0, 32)} is not supported` };
  }
  if (boot.adapter && boot.adapter !== adapter) {
    throw { code: 409, msg: `this host runs ${boot.adapter}, not ${adapter}` };
  }
  if (input.rebootAfter !== undefined) {
    // Not a parameter. Image operations never reboot, and accepting the field
    // at all would suggest otherwise.
    throw { code: 400, msg: 'image operations never reboot; rebootAfter is not accepted' };
  }

  let image = '';
  if (operation === 'osimage.stage') {
    if (boot.canStage !== true) {
      throw { code: 409, msg: `the ${adapter} on this host does not expose a staging command` };
    }
    image = String(input.image ?? '');
    if (!PINNED_IMAGE_RE.test(image)) {
      // A tag can be moved by whoever controls the registry, which makes it a
      // target nobody can review. A digest cannot.
      throw { code: 400, msg: 'image must be a digest-pinned reference ending in @sha256:<64 hex>' };
    }
    refuseUnlessAgentAllows(
      agentAllowlist(snapshot, 'imageAllowlist').includes(image),
      'that image', 'stage');
  } else {
    if (input.image !== undefined && input.image !== '') {
      throw { code: 400, msg: 'osimage.rollback names no image; it returns to the previous deployment' };
    }
    if (boot.rollbackAvailable !== true) {
      throw { code: 409, msg: 'this host has no previous deployment to roll back to' };
    }
  }

  const booted = boot.booted && typeof boot.booted === 'object' ? boot.booted : {};
  return {
    adapter,
    image,
    preState: {
      model: adapter,
      bootedDigest: String(booted.digest || ''),
      bootedVersion: String(booted.version || ''),
      rollbackAvailable: boot.rollbackAvailable === true,
    },
  };
}

/** Builds the agent-facing plan from a stored row. Never includes free text. */
function planFor(row, nowMs) {
  const issued = new Date(nowMs);
  const leaseSeconds = LEASE_SECONDS[row.operation] || 120;
  // A plan must outlive the lease it hands out. host.reboot leases 900s, which
  // is longer than the default plan lifetime, and a lease outliving its own
  // authorisation is one the agent refuses to honour.
  const expires = new Date(nowMs + Math.max(PLAN_LIFETIME_SECONDS, leaseSeconds) * 1000);
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    operationId: row.id,
    attempt: row.lease_attempt,
    controlCenterId: row.control_center_id,
    hostId: row.host_id,
    operation: row.operation,
    contentDigest: row.content_digest,
    issuedAt: issued.toISOString(),
    notBefore: issued.toISOString(),
    expiresAt: expires.toISOString(),
    leaseExpiresAt: new Date(nowMs + leaseSeconds * 1000).toISOString(),
  };
  const parameters = row.parameters || {};
  if (row.operation === 'journal.query') {
    plan.journal = {
      units: parameters.units || [],
      priority: parameters.priority || '',
      since: parameters.since || '',
      until: parameters.until || '',
      cursor: parameters.cursor || '',
      lines: parameters.lines || 200,
      maxBytes: 0,
    };
  } else if (row.operation === 'service.restart') {
    plan.service = { unit: parameters.unit };
  } else if (row.operation === 'package.refresh') {
    plan.packageRefresh = { manager: parameters.manager || SUPPORTED_PACKAGE_MANAGER };
  } else if (row.operation === 'package.update') {
    plan.packageUpdate = {
      manager: parameters.manager || SUPPORTED_PACKAGE_MANAGER,
      packages: (parameters.packages || []).map((entry) => ({
        name: entry.name, version: entry.version || '',
      })),
      securityOnly: parameters.securityOnly === true,
    };
  } else if (row.operation === 'kernel.update') {
    plan.kernelUpdate = {
      manager: parameters.manager || SUPPORTED_PACKAGE_MANAGER,
      targetRelease: parameters.targetRelease || '',
      // Always false. The agent refuses a plan that sets it, so this is a
      // statement of intent that both sides can check rather than a setting.
      rebootAfter: false,
    };
  } else if (row.operation === 'host.reboot') {
    plan.reboot = {
      // The agent refuses a reboot that is not backed by a confirmed drain.
      drainConfirmed: row.maintenance?.drain?.drained === true,
      deadlineSeconds: parameters.deadlineSeconds || 600,
    };
  } else if (row.operation === 'network.configure') {
    plan.network = {
      adapter: parameters.adapter || NETWORK_ADAPTER,
      connection: parameters.connection,
      interface: parameters.interface,
      method: parameters.method,
      addresses: parameters.addresses || [],
      gateway: parameters.gateway || '',
      dns: parameters.dns || [],
      searchDomains: parameters.searchDomains || [],
      mtu: parameters.mtu || 0,
      rollbackSeconds: parameters.rollbackSeconds || DEFAULT_ROLLBACK_SECONDS,
      preState: parameters.preState || null,
    };
  } else if (row.operation === 'mount.configure') {
    plan.mount = {
      adapter: parameters.adapter || STORAGE_ADAPTER,
      filesystemUuid: parameters.filesystemUuid,
      mountPoint: parameters.mountPoint,
      fsType: parameters.fsType,
      readOnly: parameters.readOnly === true,
      noExec: parameters.noExec === true,
      noSuid: parameters.noSuid === true,
      noDev: parameters.noDev === true,
      preState: parameters.preState || null,
    };
  } else if (row.operation === 'filesystem.grow') {
    plan.filesystemGrow = {
      adapter: parameters.adapter || STORAGE_ADAPTER,
      mountPoint: parameters.mountPoint,
      preState: parameters.preState || null,
    };
  } else if (row.operation === 'osimage.stage' || row.operation === 'osimage.rollback') {
    plan.osImage = {
      adapter: parameters.adapter,
      image: parameters.image || '',
      // Always false. The agent refuses a plan that sets it, so this is a
      // statement of intent both sides can check rather than a setting.
      rebootAfter: false,
      preState: parameters.preState || null,
    };
  } else if (row.operation === 'ssh.ban' || row.operation === 'ssh.unban') {
    plan.sshBan = {
      jail: 'sshd',
      address: parameters.address,
      expectedBanned: parameters.expectedBanned === true,
    };
  } else if (row.operation === 'ssh.protection.enable') {
    plan.sshProtection = {
      provider: 'fail2ban',
      jail: 'sshd',
      profile: parameters.profile,
      packageVersion: parameters.packageVersion || '',
      expectedProfileDigest: parameters.expectedProfileDigest || '',
      expectedInstalled: parameters.expectedInstalled === true,
      expectedActive: parameters.expectedActive === true,
      protectedAddresses: parameters.protectedAddresses || [],
    };
  }
  if (row.policy_id) {
    plan.policy = {
      policyId: row.policy_id,
      policyVersion: Number(row.policy_version),
      windowId: row.policy_window_id || '',
      // The control center resolves the window to UTC instants in the policy's
      // own timezone. The agent compares wall-clock UTC against these, so it
      // never carries a timezone database or reasons about DST itself.
      windowStart: row.policy_window_start || null,
      windowEnd: row.policy_window_end || null,
      emergency: row.policy_emergency === true,
    };
    if (plan.policy.emergency) {
      // An emergency has no window to be inside. Sending one would let the plan
      // claim a protection it never had.
      plan.policy.windowStart = undefined;
      plan.policy.windowEnd = undefined;
    }
  }
  return plan;
}

/** Rollback states an agent may report. Anything else is not recorded. */
const ROLLBACK_STATES = new Set(['armed', 'confirmed', 'rolled-back', 'rollback-failed', 'not-recorded']);

/**
 * The rollback state a receipt establishes.
 *
 * Only an operation that was armed can report one, and only a value from the
 * closed set is accepted: an agent inventing a state must not be able to write
 * an arbitrary string into a column an operator reads as the platform's own
 * record. A receipt that stops at "armed" is treated as "we do not know",
 * because an agent that applied the change and then died is exactly the case
 * where "armed" would read as reassurance.
 */
function rollbackStateFrom(row, receipt) {
  if (row.host_operation_type?.requires_rollback !== true) return null;
  const reported = String(receipt?.evidence?.rollbackState ?? '');
  if (!ROLLBACK_STATES.has(reported)) return 'not-recorded';
  if (reported === 'armed') return 'not-recorded';
  return reported;
}

/** Validates an agent receipt before any of it is stored. */
function validateReceipt(raw, row) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw { code: 400, msg: 'receipt must be an object' };
  }
  if (raw.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw { code: 422, msg: 'unsupported receipt schema' };
  }
  if (raw.operationId !== row.id) throw { code: 422, msg: 'receipt is for another operation' };
  if (Number(raw.attempt) !== Number(row.lease_attempt)) {
    // A receipt from an older attempt would overwrite the current one.
    throw { code: 409, msg: 'receipt is for a superseded attempt' };
  }
  // The receipt must name the same work, for the same host, in the same control
  // center. Checking only the operation id would let a receipt whose body
  // describes different work be filed against this operation, and the stored
  // result would then disagree with the document the agent signed.
  if (raw.controlCenterId !== row.control_center_id) {
    throw { code: 422, msg: 'receipt is for another control center' };
  }
  const hostId = row.host?.host_id ?? row.host_id ?? null;
  if (raw.hostId !== hostId) throw { code: 422, msg: 'receipt is for another host' };
  if (raw.operation !== row.operation) {
    throw { code: 422, msg: 'receipt describes a different operation type' };
  }
  if (raw.contentDigest !== row.content_digest) {
    throw { code: 422, msg: 'receipt does not match the approved content' };
  }
  if (raw.outcome !== 'succeeded' && raw.outcome !== 'failed') {
    throw { code: 422, msg: 'receipt outcome is not recognised' };
  }
  const bounded = (value, max) => String(value ?? '').replace(new RegExp('[\u0000-\u001f\u007f]', 'g'), '').slice(0, max);
  // The agent requires both timestamps and requires them to be ordered before
  // it will sign a receipt. Accepting a weaker document than the agent could
  // have produced means the stored history can say a run finished before it
  // started, and nothing downstream would notice.
  const startedMs = Date.parse(String(raw.startedAt ?? ''));
  const finishedMs = Date.parse(String(raw.finishedAt ?? ''));
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) {
    throw { code: 422, msg: 'receipt must carry when the work started and when it finished' };
  }
  if (finishedMs < startedMs) {
    throw { code: 422, msg: 'receipt reports finishing before it started' };
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: row.id,
    attempt: Number(raw.attempt),
    controlCenterId: row.control_center_id,
    hostId,
    operation: row.operation,
    contentDigest: row.content_digest,
    outcome: raw.outcome,
    exitCode: Number.isFinite(Number(raw.exitCode)) ? Math.trunc(Number(raw.exitCode)) : -1,
    startedAt: bounded(raw.startedAt, 64),
    finishedAt: bounded(raw.finishedAt, 64),
    message: bounded(raw.message, 1000),
    truncated: raw.truncated === true,
    output: bounded(raw.output, MAX_RECEIPT_OUTPUT),
    evidence: raw.evidence && typeof raw.evidence === 'object' && !Array.isArray(raw.evidence)
      ? Object.fromEntries(Object.entries(raw.evidence).slice(0, 24).map(([k, v]) => [bounded(k, 64), bounded(v, 512)]))
      : {},
  };
}

/**
 * Public projection of an operation row.
 *
 * `viewer` is derived from the session on the server. The console needs to
 * explain why an approve button is off, and the honest answer is sometimes
 * "because you are the person who asked for this". Working that out in the
 * browser would mean trusting the browser's idea of who it is.
 */
function toOperation(row, actor = null) {
  return {
    id: row.id,
    hostId: row.host?.host_id ?? row.host_id ?? null,
    controlCenterId: row.control_center_id,
    operation: row.operation,
    parameters: row.parameters || {},
    reason: row.reason,
    status: row.status,
    riskLevel: row.host_operation_type?.risk_level ?? null,
    requiresSecondPerson: row.host_operation_type?.requires_second_person ?? null,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    decidedReason: row.decided_reason,
    contentDigest: row.content_digest,
    approvalBindsCurrentContent: Boolean(row.approved_digest) && row.approved_digest === row.content_digest,
    viewer: actor ? {
      isRequester: row.requested_by === actor.sub,
      isApprover: Boolean(row.approved_by) && row.approved_by === actor.sub,
    } : null,
    attempt: row.lease_attempt,
    leaseExpiresAt: row.lease_expires_at,
    // The rollback an operator watches is the one the host acted on: the
    // deadline is set at dispatch and the state comes from the agent receipt.
    adapter: row.adapter ?? null,
    requiresRollback: row.host_operation_type?.requires_rollback === true,
    rollbackDeadlineAt: row.rollback_deadline_at ?? null,
    rollbackState: row.rollback_state ?? 'none',
    policy: row.policy_id ? {
      id: row.policy_id,
      version: row.policy_version,
      emergency: row.policy_emergency === true,
      windowId: row.policy_window_id ?? null,
    } : null,
    startedAt: row.started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    maintenance: row.maintenance || {},
    result: row.result || null,
  };
}

const OPERATION_SELECT = 'id,request_id,host_uuid,control_center_id,operation,parameters,reason,status,'
  + 'requested_by,approved_by,approved_at,approved_digest,decided_reason,content_digest,'
  + 'lease_owner,lease_attempt,lease_expires_at,started_at,created_at,updated_at,completed_at,'
  + 'maintenance,result,result_digest,policy_id,policy_version,policy_emergency,policy_window_id,'
  + 'adapter,rollback_deadline_at,rollback_state,'
  // The snapshot is embedded because Kubernetes preparation needs the host's
  // own reported hostname to find its node when the host id is neither the node
  // name nor its kubernetes.io/hostname label. Without it that fallback
  // resolves to the empty string and every reboot on such a host fails to
  // prepare, with a message that blames the node mapping.
  + 'host(host_id,display_name,agent_key_id,host_snapshot(payload)),'
  + 'host_operation_type(risk_level,requires_second_person,requires_maintenance,required_permission,'
  + 'requires_policy,requires_rollback)';

function createOperationApi({
  restRequest,
  verifyOperator,
  requirePermission,
  requireAssurance,
  audit,
  allowedControlCenters: allowedInput,
  resolveAgentKey,
  readRawBody,
  nonceCache,
  maintenance = null,
  now = () => Date.now(),
  logger = null,
}) {
  const allowedControlCenters = new Set(allowedInput || ['cc2']);

  function log(level, message, detail = {}) {
    if (logger) logger(JSON.stringify({ level, msg: message, ...detail }));
  }

  async function loadOperation(controlCenterId, operationId) {
    const rows = await restRequest('host_operation', {
      query: [
        `id=eq.${encodeURIComponent(operationId)}`,
        `control_center_id=eq.${encodeURIComponent(controlCenterId)}`,
        `select=${OPERATION_SELECT}`,
      ].join('&'),
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function loadHost(controlCenterId, hostId) {
    const rows = await restRequest('host', {
      query: [
        `control_center_id=eq.${encodeURIComponent(controlCenterId)}`,
        `host_id=eq.${encodeURIComponent(hostId)}`,
        'select=id,host_id,control_center_id,status,agent_key_id,restart_allowlist,host_snapshot(payload)',
      ].join('&'),
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  /** Append-only event. Failure to record an event never silently succeeds. */
  /**
   * Appends an event.
   *
   * The hash is a pure function of the event's content, with no clock in it, so
   * emitting the same event twice is genuinely the same row. Together with the
   * table's UNIQUE (operation_id, phase, event_hash) and ignore-duplicates,
   * that makes the write idempotent — which is what allows a lost event to be
   * re-derived from the row later without inventing a second one.
   */
  async function recordEvent(operationId, phase, actorType, actorId, result, detail) {
    const payload = {
      operation_id: operationId,
      phase,
      actor_type: actorType,
      actor_id: actorId || null,
      result: String(result).slice(0, 64),
      detail: detail || {},
      event_hash: digestOf(
        `${operationId}|${phase}|${actorType}|${actorId || ''}|${result}|${JSON.stringify(canonicalize(detail || {}))}`,
      ),
    };
    await restRequest('host_operation_event', {
      method: 'POST',
      // Name the constraint the duplicate resolves against: it is a UNIQUE, not
      // the primary key, so PostgREST cannot infer it.
      query: 'on_conflict=operation_id,phase,event_hash',
      prefer: 'return=minimal,resolution=ignore-duplicates',
      body: [payload],
    });
  }

  /**
   * The event a row's current state implies, derived only from the row.
   *
   * A transition and its event are two writes. A crash between them leaves a
   * state with no record of how it was reached, and the journal an approver
   * reads then disagrees with reality. Because this derivation is total and
   * matches what the original call emitted byte for byte, replaying it later
   * either restores the missing event or changes nothing at all.
   */
  function impliedEvent(row) {
    switch (row.status) {
      case 'leased':
        return { phase: 'leased', actorType: 'service', result: 'ok', detail: { attempt: row.lease_attempt } };
      case 'running':
        return { phase: 'running', actorType: 'service', result: 'ok', detail: { attempt: row.lease_attempt } };
      case 'succeeded':
      case 'failed':
        return row.result ? {
          phase: row.status,
          actorType: 'service',
          result: row.result.outcome ?? row.status,
          detail: { exitCode: row.result.exitCode, truncated: row.result.truncated },
        } : null;
      default:
        return null;
    }
  }

  async function reconcileEvent(row) {
    const implied = impliedEvent(row);
    if (!implied) return false;
    await recordEvent(row.id, implied.phase, implied.actorType, null, implied.result, implied.detail);
    return true;
  }

  /**
   * Records that a node was left cordoned.
   *
   * A cordon that is never lifted removes a healthy machine from the cluster
   * without removing it from anyone's mental model. The evidence has to survive
   * the process that saw it, because that process is usually the one that has
   * just died.
   */
  async function recordDegradation(hostUuid, controlCenterId, operationId, degraded) {
    await restRequest('host_maintenance_degradation', {
      method: 'POST',
      query: 'on_conflict=host_uuid',
      prefer: 'return=minimal,resolution=merge-duplicates',
      body: [{
        host_uuid: hostUuid,
        control_center_id: controlCenterId,
        operation_id: operationId,
        node: String(degraded.node || '').slice(0, 253),
        code: degraded.code,
        detail: String(degraded.detail || '').slice(0, 2000),
        last_attempt_at: new Date(now()).toISOString(),
        resolved_at: null,
        resolution: null,
      }],
    });
    if (operationId) {
      await recordEvent(operationId, 'maintenance.degraded', 'system', null, degraded.code, {
        node: degraded.node,
        detail: String(degraded.detail || '').slice(0, 500),
      });
    }
    log('error', 'host left in a degraded maintenance state', {
      host: hostUuid, node: degraded.node, code: degraded.code,
    });
  }

  async function openDegradation(hostUuid) {
    const rows = await restRequest('host_maintenance_degradation', {
      query: [
        `host_uuid=eq.${encodeURIComponent(hostUuid)}`,
        'resolved_at=is.null',
        'select=*',
        'limit=1',
      ].join('&'),
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  /**
   * Tries to put a cordoned node back into service.
   *
   * The only automatic action here is uncordon: it is idempotent, it restores
   * the state the platform itself disturbed, and it cannot destroy anything.
   * Nothing else is attempted automatically, because every other repair needs
   * a judgement the platform is not in a position to make.
   */
  async function reconcileDegradations(host) {
    if (!maintenance) return null;
    const open = await openDegradation(host.id);
    if (!open) return null;
    if (open.attempts >= MAX_RECOVERY_ATTEMPTS) {
      if (!open.escalated) {
        await restRequest('host_maintenance_degradation', {
          method: 'PATCH',
          query: `host_uuid=eq.${encodeURIComponent(host.id)}&resolved_at=is.null`,
          prefer: 'return=minimal',
          body: { escalated: true },
        });
        log('error', 'automatic recovery exhausted; a human must uncordon this node', {
          host: host.host_id, node: open.node, attempts: open.attempts,
        });
      }
      return open;
    }

    try {
      await maintenance.uncordon(open.node);
    } catch (error) {
      await restRequest('host_maintenance_degradation', {
        method: 'PATCH',
        query: `host_uuid=eq.${encodeURIComponent(host.id)}&resolved_at=is.null`,
        prefer: 'return=minimal',
        body: {
          attempts: Number(open.attempts) + 1,
          last_attempt_at: new Date(now()).toISOString(),
          detail: String(error?.msg || error).slice(0, 2000),
        },
      });
      return open;
    }

    await restRequest('host_maintenance_degradation', {
      method: 'PATCH',
      query: `host_uuid=eq.${encodeURIComponent(host.id)}&resolved_at=is.null`,
      prefer: 'return=minimal',
      body: {
        attempts: Number(open.attempts) + 1,
        last_attempt_at: new Date(now()).toISOString(),
        resolved_at: new Date(now()).toISOString(),
        resolution: 'automatic',
      },
    });
    if (open.operation_id) {
      await recordEvent(open.operation_id, 'maintenance.uncordon', 'system', null, 'recovered', {
        node: open.node,
        attempts: Number(open.attempts) + 1,
      });
    }
    log('info', 'degraded node returned to service', { host: host.host_id, node: open.node });
    return null;
  }

  /**
   * Re-emits the events implied by this host's recent operations.
   *
   * Each write is idempotent, so the common case — every event already present
   * — costs one insert that the database discards. That is a deliberate trade:
   * a cheap repeated write in exchange for a journal that cannot silently lose
   * the record of a state change.
   */
  async function reconcileEvents(host) {
    const rows = await restRequest('host_operation', {
      query: [
        `host_uuid=eq.${encodeURIComponent(host.id)}`,
        `status=in.(${[...EVENT_BEARING_STATUSES].join(',')})`,
        `select=${OPERATION_SELECT}`,
        'order=updated_at.desc',
        `limit=${EVENT_RECONCILE_LIMIT}`,
      ].join('&'),
    });
    if (!Array.isArray(rows)) return 0;
    let reconciled = 0;
    for (const row of rows) {
      if (await reconcileEvent(row)) reconciled += 1;
    }
    return reconciled;
  }

  /**
   * Conditional update: the row must still be in `fromStatus`.
   *
   * PostgREST returns the updated rows, so an empty result means somebody else
   * changed the row first. That makes every transition a compare-and-set
   * without needing an explicit transaction.
   */
  async function transition(operationId, fromStatus, patch, guards = []) {
    const statuses = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
    const rows = await restRequest('host_operation', {
      method: 'PATCH',
      query: [
        `id=eq.${encodeURIComponent(operationId)}`,
        `status=in.(${statuses.join(',')})`,
        // Extra guards travel in the same WHERE clause as the status check, so
        // a recovery can bind the exact row it observed rather than whatever
        // the row has become since.
        ...guards,
        `select=${OPERATION_SELECT}`,
      ].join('&'),
      prefer: 'return=representation',
      body: patch,
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  /**
   * Re-drives operations stuck in `preparing`.
   *
   * `preparing` is claimed by one process and released by the same process. If
   * that process dies in between — a rollout, an OOM kill, a lost connection to
   * the maintenance service — nothing else ever looks at the row again, because
   * dispatch only reads `approved`. The operation waits forever and the node it
   * cordoned stays cordoned.
   *
   * Preparation is safe to repeat: preflight is a read, cordon is idempotent,
   * and evicting a pod that has already gone is a no-op. So a claim that has
   * gone quiet for long enough is taken over rather than left.
   */
  async function claimablePreparation(row) {
    if (row.status !== 'preparing') return true;
    // Another process is holding this claim. Taking it over while its drain is
    // still running would evict pods twice and cordon a node the first process
    // is about to uncordon, so it is only taken once the claim has gone quiet
    // for long enough that the holder is certainly gone.
    const quietSince = Date.parse(row.updated_at || 0);
    if (Number.isFinite(quietSince) && now() - quietSince < PREPARE_STALE_MS) return false;
    log('warn', 'resuming a preparation that was abandoned', { operation: row.id, since: row.updated_at });
    await recordEvent(row.id, 'preparing', 'system', null, 'resumed', { abandonedSince: row.updated_at });
    return true;
  }

  /**
   * Returns leases that expired without the agent ever starting.
   *
   * Only a lease that was never started may be requeued. If the agent did start,
   * the work may be half-done on the host, and handing the same operation to a
   * second attempt would run it twice — the one thing the whole exactly-once
   * design exists to prevent. The guards are repeated inside the update so the
   * agent cannot start in the window between reading the row and writing it.
   */
  async function requeueExpiredLeases(host) {
    const nowIso = new Date(now()).toISOString();
    const expired = await restRequest('host_operation', {
      query: [
        `host_uuid=eq.${encodeURIComponent(host.id)}`,
        'status=eq.leased',
        `lease_expires_at=lt.${encodeURIComponent(nowIso)}`,
        'started_at=is.null',
        `select=${OPERATION_SELECT}`,
        'order=created_at.asc',
        'limit=5',
      ].join('&'),
    });
    if (!Array.isArray(expired)) return 0;

    let requeued = 0;
    for (const row of expired) {
      const claimed = await transition(row.id, 'leased', {
        status: 'dispatchable',
        lease_owner: null,
        lease_expires_at: null,
      }, [
        // Exactly the lease that was observed, still unstarted, still expired.
        `lease_attempt=eq.${Number(row.lease_attempt)}`,
        'started_at=is.null',
        `lease_expires_at=lt.${encodeURIComponent(nowIso)}`,
      ]);
      if (!claimed) continue;
      requeued += 1;
      await recordEvent(row.id, 'dispatchable', 'system', null, 'lease-expired', {
        attempt: row.lease_attempt,
        expiredAt: row.lease_expires_at,
      });
    }
    return requeued;
  }


  // ── maintenance policy ─────────────────────────────────────────────────────

  /**
   * Resolves the policy governing a host, and whether it permits an operation
   * right now.
   *
   * Default-deny is the whole design. A host with no policy, a policy that does
   * not name the operation, or an instant outside every window are all
   * refusals. "We have not written a policy yet" must mean nothing happens, not
   * that anything may happen at any time.
   *
   * The window arithmetic is done by PostgreSQL in the policy's own timezone,
   * because that is where the zone database lives and where a recurring local
   * window keeps its meaning across a daylight-saving transition.
   */
  async function evaluatePolicy(host, operation, requestedEmergency) {
    const rows = await restRequest('rpc/host_effective_policy', {
      method: 'POST',
      body: { p_host_uuid: host.id },
    });
    const policyId = Array.isArray(rows) ? rows[0] : rows;
    if (!policyId) {
      return {
        allowed: false,
        code: 'no-policy',
        reason: `${host.host_id} has no maintenance policy, so package and kernel work is refused. Declare a policy with a maintenance window before requesting it.`,
      };
    }

    const policies = await restRequest('host_policy', {
      query: [
        `id=eq.${encodeURIComponent(policyId)}`,
        'select=id,name,scope,version,timezone,allowed_operations,allowed_images,allowed_mount_roots,'
        + 'emergency_allowed,emergency_requires_second_person,enabled',
        'limit=1',
      ].join('&'),
    });
    const policy = Array.isArray(policies) && policies[0] ? policies[0] : null;
    if (!policy || policy.enabled === false) {
      return { allowed: false, code: 'no-policy', reason: 'the governing policy is disabled' };
    }

    const permitted = Array.isArray(policy.allowed_operations) ? policy.allowed_operations : [];
    if (!permitted.includes(operation)) {
      // A window says when, not what. An operation the policy never named is
      // refused even in the middle of one.
      return {
        allowed: false,
        code: 'operation-not-permitted',
        policy,
        reason: `policy "${policy.name}" does not permit ${operation} on this host`,
      };
    }

    if (requestedEmergency) {
      if (!policy.emergency_allowed) {
        return {
          allowed: false,
          code: 'emergency-not-permitted',
          policy,
          reason: `policy "${policy.name}" does not allow emergency work outside a maintenance window`,
        };
      }
      // An emergency skips the window and nothing else. Approval, assurance and
      // the two-person rule are decided elsewhere and are untouched here; there
      // is deliberately no branch in this function that can relax them.
      return { allowed: true, emergency: true, policy, window: null };
    }

    const windows = await restRequest('rpc/host_policy_window_at', {
      method: 'POST',
      body: { p_policy_id: policy.id, p_at: new Date(now()).toISOString() },
    });
    const windowRow = Array.isArray(windows) && windows[0] ? windows[0] : null;
    if (!windowRow) {
      return {
        allowed: false,
        code: 'outside-window',
        policy,
        reason: `${host.host_id} is outside every maintenance window in policy "${policy.name}" (${policy.timezone})`,
      };
    }
    return {
      allowed: true,
      emergency: false,
      policy,
      window: {
        id: windowRow.window_id,
        start: windowRow.window_start,
        end: windowRow.window_end,
      },
    };
  }

  /** The reported payload for a host row, or null. */
  function snapshotPayload(host) {
    const snapshot = Array.isArray(host?.host_snapshot) ? host.host_snapshot[0] : host?.host_snapshot;
    const payload = snapshot?.payload;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  }

  /**
   * Refuses work the host has not reported it will accept.
   *
   * The UI projects these intersections so operators do not see dead controls,
   * and the agent checks them again against its live configuration. The request
   * API must still enforce the same boundary: otherwise a caller can bypass the
   * UI, complete approval and dispatch, and only then learn that the host was
   * never authorised to run the operation.
   */
  function requireHostReportedAuthority(host, operation, parameters) {
    const snapshot = snapshotPayload(host);
    const operations = snapshot?.operations;

    if (operation === 'service.restart') {
      const granted = Array.isArray(host?.restart_allowlist) ? host.restart_allowlist : [];
      const reported = agentAllowlist(snapshot, 'restartAllowlist');
      if (!granted.includes(parameters.unit)) {
        throw {
          code: 409,
          msg: `this control center does not allowlist ${parameters.unit} for restart on ${host.host_id}`,
        };
      }
      refuseUnlessAgentAllows(
        reported.includes(parameters.unit),
        parameters.unit,
        'restart');
      return;
    }

    if (operation === 'ssh.protection.enable') {
      const state = snapshot?.sshBan || {};
      if (operations?.sshBanEnabled !== true) {
        throw { code: 409, msg: "this host's agent has not enabled SSH protection operations" };
      }
      const reported = [...new Set(
        agentAllowlist(snapshot, 'sshProtectedAddresses')
          .map(canonicalIPAddress).filter(Boolean),
      )].sort();
      if (reported.length === 0
          || JSON.stringify(reported) !== JSON.stringify(parameters.protectedAddresses)) {
        throw { code: 409, msg: 'protected management addresses changed after this request was reviewed' };
      }
      if ((state.active === true) !== (parameters.expectedActive === true)) {
        throw { code: 409, msg: 'the Fail2ban sshd jail activation state changed after review' };
      }
      if ((state.installed === true) !== (parameters.expectedInstalled === true)) {
        throw { code: 409, msg: 'the Fail2ban installation state changed after review' };
      }
      const currentVersion = state.installed === true
        ? String(state.packageVersion || '') : String(state.candidateVersion || '');
      if (currentVersion !== parameters.packageVersion) {
        throw {
          code: 409,
          msg: 'the installed or candidate Fail2ban version changed after this request was reviewed',
        };
      }
      if (String(state.profileDigest || '') !== String(parameters.expectedProfileDigest || '')) {
        throw { code: 409, msg: 'the RCC Fail2ban profile changed after this request was reviewed' };
      }
      return;
    }

    if (!['package.refresh', 'package.update', 'kernel.update'].includes(operation)) return;
    if (operations?.packagesEnabled !== true) {
      throw { code: 409, msg: "this host's agent has not enabled package operations" };
    }
    const packages = snapshot?.packages;
    if (packages?.supported !== true || packages.manager !== SUPPORTED_PACKAGE_MANAGER) {
      throw {
        code: 409,
        msg: packages?.unsupportedReason
          || 'this host does not report an apt package manager this platform can operate',
      };
    }
    if (operation === 'package.refresh') return;

    if (operation === 'package.update') {
      const allowlist = agentAllowlist(snapshot, 'packageAllowlist');
      const pending = Array.isArray(packages.pending) ? packages.pending : [];
      for (const requested of parameters.packages) {
        refuseUnlessAgentAllows(
          allowlist.includes(requested.name),
          requested.name,
          'update');
        const offered = pending.find((entry) => entry?.name === requested.name);
        if (!offered) {
          throw { code: 409, msg: `${requested.name} is not reported as a pending update on this host` };
        }
        if (String(offered.candidateVersion || '') !== requested.version) {
          throw {
            code: 409,
            msg: `${requested.name} is now offered as ${String(offered.candidateVersion || 'no candidate')}, not ${requested.version}; review the current version and request again`,
          };
        }
        if (parameters.securityOnly === true && offered.security !== true) {
          throw {
            code: 409,
            msg: `${requested.name} is not reported as a security update, so this request cannot claim securityOnly`,
          };
        }
      }
      return;
    }

    const candidate = String(snapshot?.kernel?.candidate || '');
    if (candidate === '' || candidate !== parameters.targetRelease) {
      throw {
        code: 409,
        msg: candidate === ''
          ? 'this host reports no candidate kernel release'
          : `this host now offers kernel ${candidate}, not ${parameters.targetRelease}; review the current release and request again`,
      };
    }
  }

  /**
   * Whether the policy permits this operation's *target*.
   *
   * The operation list is a list of verbs. An operation that names an image or
   * creates a mount point also names a thing, and a policy that permits the
   * verb without naming any thing has not decided anything. Default-deny
   * applies here exactly as it does to the verb: an empty list is a refusal.
   */
  function policyPermitsTarget(policy, operation, parameters) {
    if (!policy) return { ok: false, reason: 'no policy governs this host' };
    const images = Array.isArray(policy.allowed_images) ? policy.allowed_images : [];
    const roots = Array.isArray(policy.allowed_mount_roots) ? policy.allowed_mount_roots : [];

    if (operation === 'osimage.stage') {
      if (images.length === 0) {
        return {
          ok: false,
          reason: `policy "${policy.name}" allowlists no image, so nothing may be staged on this host`,
        };
      }
      if (!images.includes(parameters.image)) {
        return {
          ok: false,
          reason: `policy "${policy.name}" does not allowlist that image digest`,
        };
      }
    }
    if (operation === 'mount.configure') {
      if (roots.length === 0) {
        return {
          ok: false,
          reason: `policy "${policy.name}" declares no mount roots, so no mount point may be created on this host`,
        };
      }
      const mountPoint = String(parameters.mountPoint || '');
      // The root itself is never a valid target: mounting onto /srv would hide
      // whatever is already there.
      const permitted = roots.some((root) => mountPoint.startsWith(`${String(root).replace(/\/+$/, '')}/`));
      if (!permitted) {
        return {
          ok: false,
          reason: `policy "${policy.name}" permits mount points beneath ${roots.join(', ')} only`,
        };
      }
    }
    return { ok: true };
  }

  /** Window instants are resolved per dispatch and are not stored. */
  function windowFields(binding) {
    if (!binding) return {};
    return {
      policy_window_start: binding.windowStart,
      policy_window_end: binding.windowEnd,
      policy_window_id: binding.windowId,
    };
  }

  /** The binding an operation stores and a plan carries. */
  function policyBindingOf(verdict) {
    if (!verdict?.policy) return null;
    return {
      policyId: verdict.policy.id,
      policyVersion: Number(verdict.policy.version),
      windowId: verdict.window?.id || null,
      windowStart: verdict.window?.start || null,
      windowEnd: verdict.window?.end || null,
      emergency: verdict.emergency === true,
    };
  }

  // ── operator surface ───────────────────────────────────────────────────────

  /**
   * Parses a request body, or refuses it.
   *
   * A bare JSON.parse throws a SyntaxError, which the router turns into a 500.
   * A body the client got wrong is a client error, and answering 500 tells an
   * operator the platform broke when it did not.
   */
  function parseBody(raw) {
    try {
      return JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      throw { code: 400, msg: 'request body is not valid JSON' };
    }
  }


  async function handleCreate(req, res, controlCenterId, hostId) {
    const body = parseBody(await readRawBody(req, 64 * 1024));
    const operation = String(body.operation ?? '');
    const spec = await restRequest('host_operation_type', {
      query: `operation=eq.${encodeURIComponent(operation)}&select=*`,
    });
    const type = Array.isArray(spec) && spec[0] ? spec[0] : null;
    if (!type) throw { code: 400, msg: `unknown operation ${operation.slice(0, 64)}` };

    // Authority is derived from the session and the catalog, never the body.
    const actor = await verifyOperator(req, controlCenterId, type.required_permission);
    if (type.risk_level === 'high') requireAssurance(actor);

    const reason = boundedReason(body.reason);
    const host = await loadHost(controlCenterId, hostId);
    if (!host || host.status === 'retired') throw { code: 404, msg: 'host is not enrolled' };

    // The host's own reported state is an input to normalisation from Stage 4
    // on, because the observed pre-state is part of what gets approved. It is
    // read here, server-side, and never taken from the request.
    const parameters = normalizeParameters(operation, body.parameters, {
      snapshot: snapshotPayload(host),
    });
    requireHostReportedAuthority(host, operation, parameters);

    // A host whose last maintenance left the node cordoned is already in a
    // state nobody intended. Stacking another disruptive operation on top of it
    // means draining a cluster that has less capacity than anyone thinks it
    // has. Read-only work is unaffected; disruption waits for recovery.
    if (type.risk_level === 'high' || type.requires_maintenance) {
      const degraded = await openDegradation(host.id);
      if (degraded) {
        throw {
          code: 409,
          msg: degraded.escalated
            ? `${hostId} is in a degraded maintenance state that automatic recovery could not clear: ${degraded.node} is still cordoned. An operator must return it to service before further ${operation} work is accepted.`
            : `${hostId} is in a degraded maintenance state: ${degraded.node} is still cordoned and recovery is in progress. Retry once it is back in service.`,
        };
      }
    }

    // Policy is evaluated before anything is written. A refusal must leave no
    // trace of a request that was never permitted.
    let binding = null;
    if (type.requires_policy) {
      const emergency = body.emergency === true;
      if (emergency) {
        // An emergency skips the *window*. It does not lower the bar for who
        // may ask: it is high-risk work by definition and needs the assurance
        // level regardless of what the operation catalog says.
        requireAssurance(actor);
      }
      const verdict = await evaluatePolicy(host, operation, emergency);
      if (!verdict.allowed) {
        throw { code: 409, msg: verdict.reason };
      }
      // A window says when and the operation list says what. Neither says
      // *which*, and an operation that names an image or a mount point needs
      // that governed too: permitting osimage.stage without naming images is
      // permitting any image.
      const target = policyPermitsTarget(verdict.policy, operation, parameters);
      if (!target.ok) throw { code: 409, msg: target.reason };
      binding = policyBindingOf(verdict);
    }

    const id = crypto.randomUUID();
    // The governing policy version is part of what an approval binds, so a
    // policy edit invalidates the approval rather than silently re-scoping it.
    const digest = contentDigest(operation, parameters, binding);
    await restRequest('host_operation', {
      method: 'POST',
      prefer: 'return=minimal',
      body: [{
        id,
        request_id: crypto.randomUUID(),
        host_uuid: host.id,
        control_center_id: controlCenterId,
        operation,
        parameters,
        requested_by: actor.sub,
        reason,
        content_digest: digest,
        status: 'requested',
        // The adapter is a property of the approved work, not a runtime choice.
        // Recording it means a receipt can be read against the thing that was
        // reviewed rather than against whatever the host happened to run.
        ...(parameters.adapter ? { adapter: String(parameters.adapter) } : {}),
        ...(binding ? {
          policy_id: binding.policyId,
          policy_version: binding.policyVersion,
          policy_emergency: binding.emergency,
          policy_window_id: binding.windowId,
        } : {}),
      }],
    });
    if (binding) {
      await recordEvent(id, 'policy.evaluated', 'system', null,
        binding.emergency ? 'emergency' : 'in-window', {
          policyId: binding.policyId,
          policyVersion: binding.policyVersion,
          windowId: binding.windowId,
          windowStart: binding.windowStart,
          windowEnd: binding.windowEnd,
        });
    }

    // High-risk work waits for a second person; low-risk work is approved by
    // the requester in the same step, which the database still re-checks.
    let row;
    if (type.requires_second_person) {
      row = await transition(id, 'requested', { status: 'awaiting_approval' });
      await recordEvent(id, 'awaiting_approval', 'human', actor.sub, 'ok', { operation });
    } else {
      row = await transition(id, 'requested', {
        status: 'approved',
        approved_by: actor.sub,
        approved_at: new Date(now()).toISOString(),
        approved_digest: digest,
      });
      await recordEvent(id, 'approved', 'human', actor.sub, 'ok', { operation, singlePerson: true });
    }
    await audit(actor, {
      action: 'rcc.host.operation.request',
      target: `${controlCenterId}:${hostId}:${operation}`,
      reason,
    });
    return sendJson(res, 201, { operation: toOperation(row || { id, control_center_id: controlCenterId, operation, parameters, reason, status: 'requested', content_digest: digest, lease_attempt: 0 }) });
  }

  async function handleList(req, res, controlCenterId, hostId) {
    const actor = await verifyOperator(req, controlCenterId, 'console.hosts.read');
    const host = await loadHost(controlCenterId, hostId);
    if (!host) throw { code: 404, msg: 'host is not enrolled' };
    const rows = await restRequest('host_operation', {
      query: [
        `host_uuid=eq.${encodeURIComponent(host.id)}`,
        `select=${OPERATION_SELECT}`,
        'order=created_at.desc',
        `limit=${MAX_LIST}`,
      ].join('&'),
    });
    await audit(actor, { action: 'rcc.host.operation.list', target: `${controlCenterId}:${hostId}` });
    return sendJson(res, 200, {
      controlCenterId,
      hostId,
      generatedAt: new Date(now()).toISOString(),
      items: (Array.isArray(rows) ? rows : []).map((row) => toOperation(row, actor)),
    });
  }

  async function handleDetail(req, res, controlCenterId, operationId) {
    const actor = await verifyOperator(req, controlCenterId, 'console.hosts.read');
    const row = await loadOperation(controlCenterId, operationId);
    if (!row) throw { code: 404, msg: 'operation not found' };
    const events = await restRequest('host_operation_event', {
      query: [
        `operation_id=eq.${encodeURIComponent(operationId)}`,
        'select=occurred_at,phase,actor_type,actor_id,result,detail',
        'order=occurred_at.asc',
        'limit=200',
      ].join('&'),
    });
    await audit(actor, { action: 'rcc.host.operation.read', target: operationId });
    return sendJson(res, 200, {
      operation: toOperation(row, actor),
      events: Array.isArray(events) ? events : [],
    });
  }

  async function handleDecision(req, res, controlCenterId, operationId, decision) {
    const body = parseBody(await readRawBody(req, 16 * 1024));
    const reason = boundedReason(body.reason);
    const row = await loadOperation(controlCenterId, operationId);
    if (!row) throw { code: 404, msg: 'operation not found' };

    // Deciding an operation is never a read action.
    //
    // Approving and rejecting are both review decisions and need the approval
    // permission. Cancelling needs whatever permission it would have taken to
    // request the operation in the first place. A viewer holding only
    // console.hosts.read must not be able to reject or cancel somebody else's
    // work, which the previous mapping allowed.
    const required = decision === 'cancel'
      ? (row.host_operation_type?.required_permission || 'console.hosts.operate')
      : 'console.hosts.approve';

    // Establish assignment and identity with the base read permission, then
    // demand the decision permission explicitly so the error names the right one.
    const actor = await verifyOperator(req, controlCenterId, 'console.hosts.read');
    const held = new Set(Array.isArray(actor?.permissions) ? actor.permissions : []);
    if (!held.has(required) && !(decision === 'cancel' && held.has('console.hosts.approve'))) {
      requirePermission(actor, required);
    }

    // High-risk host actions always require MFA assurance, independently of the
    // deployment-wide toggle: this is the class of action MFA exists for.
    if (row.host_operation_type?.risk_level === 'high') requireAssurance(actor);

    if (decision === 'approve') {
      // Two-person control is enforced here and again by the database trigger.
      if (row.host_operation_type?.requires_second_person && row.requested_by === actor.sub) {
        throw { code: 403, msg: 'this operation requires a different person to approve it' };
      }
      const updated = await transition(operationId, ['requested', 'awaiting_approval'], {
        status: 'approved',
        approved_by: actor.sub,
        approved_at: new Date(now()).toISOString(),
        approved_digest: row.content_digest,
        decided_reason: reason,
      });
      if (!updated) throw { code: 409, msg: 'operation is no longer awaiting approval' };
      await recordEvent(operationId, 'approved', 'human', actor.sub, 'ok', { reason });
      await audit(actor, { action: 'rcc.host.operation.approve', target: operationId, reason });
      return sendJson(res, 200, { operation: toOperation(updated) });
    }

    if (decision === 'reject') {
      const updated = await transition(operationId, ['requested', 'awaiting_approval'], {
        status: 'rejected',
        decided_reason: reason,
        completed_at: new Date(now()).toISOString(),
      });
      if (!updated) throw { code: 409, msg: 'operation is no longer awaiting approval' };
      await recordEvent(operationId, 'rejected', 'human', actor.sub, 'rejected', { reason });
      await audit(actor, { action: 'rcc.host.operation.reject', target: operationId, reason });
      return sendJson(res, 200, { operation: toOperation(updated) });
    }

    // cancel: allowed until the agent has actually started.
    const updated = await transition(
      operationId,
      ['requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable', 'leased'],
      { status: 'cancelled', decided_reason: reason, completed_at: new Date(now()).toISOString() },
    );
    if (!updated) throw { code: 409, msg: 'operation can no longer be cancelled' };
    await recordEvent(operationId, 'cancelled', 'human', actor.sub, 'cancelled', { reason });
    await audit(actor, { action: 'rcc.host.operation.cancel', target: operationId, reason });
    return sendJson(res, 200, { operation: toOperation(updated) });
  }

  // ── maintenance preparation ────────────────────────────────────────────────

  /**
   * Moves an approved operation to dispatchable, running Kubernetes maintenance
   * first when the operation type requires it.
   *
   * Safe to call repeatedly: each step is a conditional transition, so a crash
   * between steps leaves a state the next call can resume from.
   */
  /**
   * Re-checks the policy at dispatch.
   *
   * Approval happens when a human is looking; dispatch happens when the agent
   * next polls. Between the two the window closes, the policy is edited, or
   * both. Neither is unusual, and neither may be discovered by the host
   * afterwards, so the check runs again here with the current clock and the
   * current policy version.
   */
  async function policyStillPermits(row) {
    const spec = row.host_operation_type || {};
    if (!spec.requires_policy) return { ok: true };
    if (!row.policy_id) {
      return { ok: false, reason: 'this operation requires a maintenance policy and carries none' };
    }
    const verdict = await evaluatePolicy(
      { id: row.host_uuid, host_id: row.host?.host_id || row.host_uuid },
      row.operation,
      row.policy_emergency === true,
    );
    if (!verdict.allowed) return { ok: false, reason: verdict.reason };
    if (verdict.policy.id !== row.policy_id) {
      return { ok: false, reason: 'a different policy now governs this host' };
    }
    if (Number(verdict.policy.version) !== Number(row.policy_version)) {
      // The rules changed after this was reviewed. Whether the new rules would
      // also have permitted it is beside the point: nobody approved it under
      // them.
      return {
        ok: false,
        superseded: true,
        reason: `policy "${verdict.policy.name}" has changed since this was approved (version ${row.policy_version} → ${verdict.policy.version}); request it again under the current policy`,
      };
    }
    // The target list is re-checked too. The version guard above catches an
    // edited policy, but this stays as the direct check rather than an
    // inference from it: an image removed from the allowlist must not be
    // stageable, whatever else did or did not bump.
    const target = policyPermitsTarget(verdict.policy, row.operation, row.parameters || {});
    if (!target.ok) return { ok: false, reason: target.reason };
    return { ok: true, binding: policyBindingOf(verdict) };
  }

  async function prepare(row) {
    const spec = row.host_operation_type || {};

    const policyCheck = await policyStillPermits(row);
    if (!policyCheck.ok) {
      await transition(row.id, ['approved', 'preparing'], {
        status: 'failed',
        completed_at: new Date(now()).toISOString(),
        result: { outcome: 'failed', message: policyCheck.reason },
        result_digest: digestOf(String(policyCheck.reason)),
      });
      await recordEvent(row.id, policyCheck.superseded ? 'policy.superseded' : 'policy.refused',
        'system', null, 'refused', { reason: String(policyCheck.reason).slice(0, 500) });
      return null;
    }
    // The window instants are resolved fresh, so a plan carries the occurrence
    // it is actually inside rather than the one it was requested during.
    if (policyCheck.binding) {
      row = {
        ...row,
        policy_window_start: policyCheck.binding.windowStart,
        policy_window_end: policyCheck.binding.windowEnd,
        policy_window_id: policyCheck.binding.windowId,
      };
    }

    if (!spec.requires_maintenance) {
      const dispatched = await transition(row.id, 'approved', { status: 'dispatchable' });
      // The refreshed window travels with the row the poll will build a plan
      // from; it is derived state, not something the database stores.
      return dispatched ? { ...dispatched, ...windowFields(policyCheck.binding) } : null;
    }
    if (!maintenance) {
      await transition(row.id, ['approved', 'preparing'], {
        status: 'failed',
        completed_at: new Date(now()).toISOString(),
        result: { outcome: 'failed', message: 'maintenance coordinator is not configured' },
        result_digest: digestOf('no-coordinator'),
      });
      await recordEvent(row.id, 'maintenance.refused', 'system', null, 'no-coordinator', {});
      return null;
    }

    // Claim from `approved` normally, or from `preparing` when this is a
    // recovery. The guard binds the exact revision that was read, so two
    // processes recovering at once cannot both take it.
    const claimed = await transition(
      row.id,
      ['approved', 'preparing'],
      { status: 'preparing' },
      row.updated_at ? [`updated_at=eq.${encodeURIComponent(row.updated_at)}`] : [],
    );
    if (!claimed) return null; // somebody else is preparing it

    // PostgREST returns an embedded to-one either as an object or as a
    // single-element array depending on how it resolves the relationship, so
    // this goes through the same normaliser as every other read of it.
    const hostname = snapshotPayload(row.host)?.identity?.hostname || '';
    let findings;
    try {
      findings = await maintenance.prepare(row.host.host_id, hostname);
    } catch (error) {
      // A compensating uncordon that failed leaves the node out of service.
      // That outlives this operation, so it is recorded against the host.
      if (error?.degraded) {
        await recordDegradation(row.host_uuid, row.control_center_id, row.id, error.degraded);
      }
      await transition(row.id, 'preparing', {
        status: 'failed',
        completed_at: new Date(now()).toISOString(),
        result: { outcome: 'failed', message: error?.msg || 'maintenance preparation failed' },
        result_digest: digestOf(String(error?.msg || 'error')),
        maintenance: {
          prepared: false,
          error: String(error?.msg || 'error').slice(0, 500),
          ...(error?.degraded ? { degraded: error.degraded } : {}),
        },
      });
      await recordEvent(row.id, 'maintenance.refused', 'system', null, 'error', {
        error: String(error?.msg || 'error').slice(0, 500),
      });
      return null;
    }

    if (!findings.prepared) {
      if (findings.degraded) {
        await recordDegradation(row.host_uuid, row.control_center_id, row.id, findings.degraded);
      }
      await transition(row.id, 'preparing', {
        status: 'failed',
        completed_at: new Date(now()).toISOString(),
        result: { outcome: 'failed', message: 'Kubernetes preflight refused this reboot' },
        result_digest: digestOf(JSON.stringify(findings.blocking || [])),
        maintenance: { ...findings, prepared: false },
      });
      await recordEvent(row.id, 'maintenance.refused', 'system', null, 'blocked', {
        blocking: findings.blocking || [],
      });
      return null;
    }

    await recordEvent(row.id, 'maintenance.cordon', 'system', null, 'ok', { node: findings.node });
    await recordEvent(row.id, 'maintenance.drain', 'system', null, 'ok', {
      node: findings.node,
      evicted: findings.drain?.evicted?.length ?? 0,
    });
    return transition(row.id, 'preparing', {
      status: 'dispatchable',
      maintenance: { ...findings, prepared: true },
    });
  }

  /** Restores scheduling after a reboot operation reaches a terminal state. */
  async function reconcileUncordon(row) {
    if (!maintenance) return;
    const node = row.maintenance?.node;
    if (!node || row.maintenance?.cordon?.cordoned !== true) return;
    try {
      await maintenance.uncordon(node);
      await recordEvent(row.id, 'maintenance.uncordon', 'system', null, 'ok', { node });
    } catch (error) {
      // Recording it is what makes a later retry possible at all: a log line
      // disappears with the pod, and the node stays cordoned either way.
      await recordDegradation(row.host_uuid, row.control_center_id, row.id, {
        code: 'uncordon-failed',
        node,
        detail: `${node} could not be returned to service after ${row.operation}: ${String(error?.msg || error)}`,
      }).catch((failure) => {
        log('error', 'could not record the degradation either', {
          operation: row.id, node, error: String(failure?.msg || failure),
        });
      });
    }
  }

  // ── agent surface ──────────────────────────────────────────────────────────

  async function verifiedAgent(req, controlCenterId, hostId, limit = MAX_BODY_BYTES) {
    if (typeof resolveAgentKey !== 'function') {
      throw { code: 503, msg: 'agent key material is not configured' };
    }
    const raw = await readRawBody(req, limit);
    const verified = verifyAgentRequest({
      req,
      body: raw,
      resolveKey: resolveAgentKey,
      allowedControlCenters,
      nonceCache,
      nowSeconds: Math.floor(now() / 1000),
      pathOverride: req.url,
    });
    const host = await loadHost(controlCenterId, hostId);
    if (!host || host.status === 'retired') throw { code: 404, msg: 'host is not enrolled' };
    // The signing key must be the one bound to this host.
    if (host.agent_key_id !== verified.keyId) throw { code: 401, msg: 'agent key is not bound to this host' };
    // The same key signs the plan we hand back, so the agent can authenticate
    // the instruction independently of the transport.
    const key = resolveAgentKey(verified.keyId);
    if (!key || key.status !== 'active') throw { code: 401, msg: 'agent key is not accepted' };
    return { verified, host, raw, key };
  }

  /** Sends a plan body signed with the host's own key. */
  function sendSignedPlan(res, key, controlCenterId, hostId, planBody) {
    const body = Buffer.from(JSON.stringify(planBody), 'utf8');
    const headers = planResponseHeaders({
      secret: key.secret,
      keyId: key.keyId,
      controlCenterId,
      hostId,
      operationId: planBody.operationId,
      attempt: planBody.attempt,
      body,
      nowSeconds: Math.floor(now() / 1000),
      nonce: crypto.randomBytes(16).toString('hex'),
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(body);
  }

  async function handleAgentPoll(req, res, controlCenterId, hostId) {
    const { host, key } = await verifiedAgent(req, controlCenterId, hostId);

    // Advance anything that is ready before looking for dispatchable work, so a
    // crash during preparation is resumed by the next poll.
    const approved = await restRequest('host_operation', {
      query: [
        `host_uuid=eq.${encodeURIComponent(host.id)}`,
        'status=in.(approved,preparing)',
        `select=${OPERATION_SELECT}`,
        'order=created_at.asc',
        'limit=1',
      ].join('&'),
    });
    const pending = Array.isArray(approved) && approved[0] ? approved[0] : null;
    if (pending && await claimablePreparation(pending)) {
      await prepare(pending).catch((error) => {
        log('error', 'preparation failed', { operation: pending.id, error: String(error?.msg || error) });
      });
    }
    await requeueExpiredLeases(host).catch((error) => {
      log('error', 'lease requeue failed', { host: hostId, error: String(error?.msg || error) });
    });
    await reconcileEvents(host).catch((error) => {
      log('error', 'event reconciliation failed', { host: hostId, error: String(error?.msg || error) });
    });
    await reconcileDegradations(host).catch((error) => {
      log('error', 'degradation recovery failed', { host: hostId, error: String(error?.msg || error) });
    });

    const ready = await restRequest('host_operation', {
      query: [
        `host_uuid=eq.${encodeURIComponent(host.id)}`,
        'status=eq.dispatchable',
        `select=${OPERATION_SELECT}`,
        'order=created_at.asc',
        'limit=1',
      ].join('&'),
    });
    const row = Array.isArray(ready) && ready[0] ? ready[0] : null;
    if (!row) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }

    const leaseSeconds = LEASE_SECONDS[row.operation] || 120;
    // A revertable operation is armed in the same write that leases it. Doing
    // it afterwards would leave a window in which the agent holds a plan the
    // database has no deadline for, and the database trigger refuses that
    // rather than letting an unrevertable change through.
    const rollback = ROLLBACK_OPERATIONS.has(row.operation)
      ? {
        rollback_state: 'armed',
        rollback_deadline_at: new Date(
          now() + (Number(row.parameters?.rollbackSeconds) || DEFAULT_ROLLBACK_SECONDS) * 1000,
        ).toISOString(),
      }
      : {};
    const leased = await transition(row.id, 'dispatchable', {
      status: 'leased',
      lease_owner: `${hostId}:${row.lease_attempt + 1}`,
      lease_attempt: row.lease_attempt + 1,
      lease_expires_at: new Date(now() + leaseSeconds * 1000).toISOString(),
      ...rollback,
    });
    if (!leased) {
      // Another poll won the race; nothing to do this round.
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    await reconcileEvent(leased);
    if (rollback.rollback_deadline_at) {
      await recordEvent(leased.id, 'rollback.armed', 'system', null, 'armed', {
        deadline: rollback.rollback_deadline_at,
        attempt: leased.lease_attempt,
      });
    }

    // A governed operation may have waited in the queue. Re-check the window
    // now, and give the plan the occurrence it is actually inside so the agent
    // can refuse it later if it waits again.
    let leaseBinding = {};
    if (leased.host_operation_type?.requires_policy) {
      const stillPermitted = await policyStillPermits(leased);
      if (!stillPermitted.ok) {
        await transition(leased.id, 'leased', {
          status: 'failed',
          completed_at: new Date(now()).toISOString(),
          result: { outcome: 'failed', message: stillPermitted.reason },
          result_digest: digestOf(String(stillPermitted.reason)),
        });
        await recordEvent(leased.id,
          stillPermitted.superseded ? 'policy.superseded' : 'policy.refused',
          'system', null, 'refused', { reason: String(stillPermitted.reason).slice(0, 500) });
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }
      leaseBinding = windowFields(stillPermitted.binding);
    }
    return sendSignedPlan(res, key, controlCenterId, hostId,
      planFor({ ...leased, ...leaseBinding, host_id: hostId }, now()));
  }

  async function handleAgentStart(req, res, controlCenterId, hostId) {
    const { raw } = await verifiedAgent(req, controlCenterId, hostId);
    const body = parseBody(raw);
    const operationId = String(body.operationId ?? '');
    if (!UUID_RE.test(operationId)) throw { code: 400, msg: 'operationId is malformed' };
    const attempt = Number(body.attempt);

    const row = await loadOperation(controlCenterId, operationId);
    if (!row) throw { code: 404, msg: 'operation not found' };
    if (row.host?.host_id !== hostId) throw { code: 403, msg: 'operation belongs to another host' };
    if (Number(row.lease_attempt) !== attempt) throw { code: 409, msg: 'attempt is superseded' };

    // A start is the agent asserting which work it is about to perform. It must
    // name that work exactly: same control center, same host, same operation,
    // same approved content. Accepting a start that only matched the id would
    // let an agent holding a stale plan begin work the approval never covered.
    if (body.controlCenterId !== undefined && body.controlCenterId !== controlCenterId) {
      throw { code: 403, msg: 'start names another control center' };
    }
    if (body.hostId !== undefined && body.hostId !== hostId) {
      throw { code: 403, msg: 'start names another host' };
    }
    if (body.operation !== row.operation) {
      throw { code: 409, msg: 'start names a different operation than the one leased' };
    }
    if (body.contentDigest !== row.content_digest) {
      throw { code: 409, msg: 'start does not match the approved content' };
    }

    const started = await transition(operationId, 'leased', {
      status: 'running',
      started_at: new Date(now()).toISOString(),
    });
    if (!started) throw { code: 409, msg: 'operation is not leased to this attempt' };
    await reconcileEvent(started);
    return sendJson(res, 200, { started: true, operationId, attempt });
  }

  async function handleAgentReceipt(req, res, controlCenterId, hostId) {
    const { raw } = await verifiedAgent(req, controlCenterId, hostId, MAX_RECEIPT_BYTES);
    if (raw.length > MAX_RECEIPT_BYTES) throw { code: 413, msg: 'receipt too large' };
    const body = parseBody(raw);
    const operationId = String(body.operationId ?? '');
    if (!UUID_RE.test(operationId)) throw { code: 400, msg: 'operationId is malformed' };

    const row = await loadOperation(controlCenterId, operationId);
    if (!row) throw { code: 404, msg: 'operation not found' };
    if (row.host?.host_id !== hostId) throw { code: 403, msg: 'operation belongs to another host' };

    // A replayed receipt for an already-finished operation is success ONLY when
    // it is byte-for-byte the receipt we already hold. Acknowledging any replay
    // would let a divergent result be silently accepted by the agent, and the
    // disagreement would never surface anywhere.
    if (row.completed_at) {
      // The stored receipt records the digest of the exact bytes the agent
      // sent, so a replay can be compared against precisely that. Comparing a
      // re-canonicalised form instead would accept a receipt that differed in
      // any field the canonicaliser drops.
      const storedDigest = row.result?.receiptDigest || null;
      const presentedDigest = digestOf(raw);
      const replayMatches = Boolean(storedDigest)
        && String(body.operationId) === row.id
        && Number(body.attempt) === Number(row.lease_attempt)
        && storedDigest === presentedDigest;
      if (!replayMatches) {
        return sendJson(res, 409, {
          accepted: false,
          alreadyRecorded: true,
          operationId: row.id,
          attempt: row.lease_attempt,
          status: row.status,
          receiptDigest: storedDigest,
          error: 'a different result is already recorded for this operation',
        });
      }
      return sendJson(res, 409, {
        accepted: true,
        alreadyRecorded: true,
        operationId: row.id,
        attempt: row.lease_attempt,
        status: row.status,
        receiptDigest: presentedDigest,
      });
    }

    const receipt = validateReceipt(body, row);
    // Pin the exact bytes received; a later replay must present the same ones.
    receipt.receiptDigest = digestOf(raw);
    const status = receipt.outcome === 'succeeded' ? 'succeeded' : 'failed';
    // What the host actually did with the rollback, taken from the receipt the
    // agent signed. An operator reading this is reading the host's own account
    // of whether the change survived, not the platform's expectation of it.
    const rollbackState = rollbackStateFrom(row, receipt);
    const finished = await transition(operationId, ['running', 'leased'], {
      status,
      completed_at: new Date(now()).toISOString(),
      result: receipt,
      result_digest: digestOf(JSON.stringify(canonicalize(receipt))),
      ...(rollbackState ? { rollback_state: rollbackState } : {}),
    });
    if (!finished) throw { code: 409, msg: 'operation is not awaiting a receipt' };
    await reconcileEvent(finished);
    if (rollbackState === 'confirmed') {
      await recordEvent(operationId, 'rollback.confirmed', 'service', null, 'confirmed', {
        confirmedAt: String(receipt.evidence?.confirmedAt || '').slice(0, 64),
      });
    } else if (rollbackState === 'rolled-back' || rollbackState === 'rollback-failed') {
      await recordEvent(operationId, 'rollback.executed', 'service', null, rollbackState, {
        detail: String(receipt.evidence?.confirmationError || receipt.message || '').slice(0, 500),
      });
    }

    // A rebooted node must be made schedulable again.
    if (finished.host_operation_type?.requires_maintenance) {
      await reconcileUncordon(finished);
    }
    return sendJson(res, 200, {
      accepted: true,
      status,
      operationId: operationId,
      attempt: Number(row.lease_attempt),
      receiptDigest: receipt.receiptDigest,
    });
  }

  // ── routing ────────────────────────────────────────────────────────────────

  function parseRoute(rawUrl) {
    const url = new URL(String(rawUrl ?? ''), 'http://polyon-rcc.local');
    const viaPlugin = url.pathname.startsWith(`${PLUGIN_API_NAMESPACE}/`);
    const pathname = viaPlugin ? `/api${url.pathname.slice(PLUGIN_API_NAMESPACE.length)}` : url.pathname;

    const hostScoped = OPERATION_ROUTE_RE.exec(pathname);
    if (hostScoped) {
      const [, controlCenterId, hostId, action] = hostScoped;
      if (!DNS_LABEL_RE.test(controlCenterId) || !DNS_LABEL_RE.test(hostId)) {
        throw { code: 400, msg: 'invalid host route' };
      }
      if (!allowedControlCenters.has(controlCenterId)) throw { code: 404, msg: 'control center is not configured' };
      // Agent endpoints are never reachable through the browser-facing prefix.
      if (['poll', 'start', 'receipt'].includes(action || '')) {
        if (viaPlugin) throw { code: 404, msg: 'unknown operation route' };
        return { kind: `agent:${action}`, controlCenterId, hostId };
      }
      if (action) throw { code: 404, msg: 'unknown operation route' };
      return { kind: 'collection', controlCenterId, hostId, viaPlugin };
    }

    const itemScoped = OPERATION_ITEM_ROUTE_RE.exec(pathname);
    if (itemScoped) {
      const [, controlCenterId, operationId, action] = itemScoped;
      if (!allowedControlCenters.has(controlCenterId)) throw { code: 404, msg: 'control center is not configured' };
      if (!UUID_RE.test(operationId)) throw { code: 400, msg: 'invalid operation id' };
      if (action && !['approve', 'reject', 'cancel'].includes(action)) {
        throw { code: 404, msg: 'unknown operation action' };
      }
      return { kind: action ? `decision:${action}` : 'item', controlCenterId, operationId, viaPlugin };
    }
    return null;
  }

  async function handle(req, res) {
    let route;
    try {
      route = parseRoute(req.url);
    } catch (error) {
      sendJson(res, error?.code || 400, { error: error?.msg || 'invalid route' });
      return true;
    }
    if (!route) return false;

    const method = String(req.method || '').toUpperCase();
    try {
      if (route.kind.startsWith('agent:')) {
        if (method !== 'POST') throw { code: 405, msg: 'agent endpoints accept POST only' };
        const action = route.kind.slice('agent:'.length);
        if (action === 'poll') await handleAgentPoll(req, res, route.controlCenterId, route.hostId);
        else if (action === 'start') await handleAgentStart(req, res, route.controlCenterId, route.hostId);
        else await handleAgentReceipt(req, res, route.controlCenterId, route.hostId);
        return true;
      }
      if (route.kind === 'collection') {
        if (method === 'GET') await handleList(req, res, route.controlCenterId, route.hostId);
        else if (method === 'POST') await handleCreate(req, res, route.controlCenterId, route.hostId);
        else throw { code: 405, msg: 'method not allowed' };
        return true;
      }
      if (route.kind === 'item') {
        if (method !== 'GET') throw { code: 405, msg: 'method not allowed' };
        await handleDetail(req, res, route.controlCenterId, route.operationId);
        return true;
      }
      if (route.kind.startsWith('decision:')) {
        if (method !== 'POST') throw { code: 405, msg: 'method not allowed' };
        await handleDecision(req, res, route.controlCenterId, route.operationId, route.kind.slice('decision:'.length));
        return true;
      }
      throw { code: 404, msg: 'unknown operation route' };
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, error?.code || 500, { error: error?.msg || 'operation request failed' });
      }
      return true;
    }
  }

  return { handle, parseRoute, prepare, reconcileUncordon, contentDigest, normalizeParameters, planFor, validateReceipt };
}

module.exports = {
  PLAN_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  LEASE_SECONDS,
  MAX_POLL_WAIT_SECONDS,
  canonicalize,
  contentDigest,
  normalizeParameters,
  planFor,
  toOperation,
  createOperationApi,
};
