'use strict';

/**
 * Kubernetes maintenance coordinator for host reboots.
 *
 * Rebooting a node that still runs workloads, or that is the only control-plane
 * member, turns a routine maintenance action into an outage. Before a reboot
 * becomes dispatchable this module must answer, from the live cluster:
 *
 *   - which Node is this Host?
 *   - is it Ready, and is it under resource pressure?
 *   - would draining it violate a PodDisruptionBudget?
 *   - does it carry pods that cannot be evicted safely?
 *   - is it a control-plane node, and would losing it break etcd quorum?
 *   - can the remaining nodes absorb its workload?
 *
 * Every answer is recorded as evidence on the operation, so an approver sees
 * what the cluster looked like when the decision was made.
 *
 * Fail closed: any unreadable input, any unexpected shape, any error is a
 * refusal. The cost of refusing a reboot is a retry; the cost of proceeding on
 * incomplete information is an outage.
 *
 * The Kubernetes surface used here is deliberately narrow and is granted by a
 * separate ClusterRole: node get/list/patch, bounded pod and PDB reads, and
 * pods/eviction create. It cannot read Secrets, edit workloads, create pods, or
 * exec into anything.
 */

const MAX_PODS = 500;
const EVICTION_API_VERSION = 'policy/v1';
const DEFAULT_DRAIN_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const ETCD_TOPOLOGIES = new Set(['stacked', 'external']);

/**
 * What to do about pods a drain cannot simply move.
 *
 * Every entry defaults to refusing. Silently skipping these is how a drain
 * reports success while the node still runs the workload, so each one has to be
 * a declared operational decision rather than an implicit default. The deploy
 * manifest states the cluster's answers; anything undeclared stops the reboot.
 */
const DRAIN_POLICY_CHOICES = {
  // DaemonSet pods are re-created by their controller when the kubelet returns.
  daemonSetPods: ['refuse', 'leave-in-place'],
  // Static pods are owned by the kubelet and cannot be evicted through the API.
  staticPods: ['refuse', 'leave-in-place'],
  // emptyDir contents do not survive the move; losing them must be chosen.
  emptyDirData: ['refuse', 'accept-data-loss'],
};

function resolveDrainPolicy(overrides = {}) {
  const policy = {};
  for (const [key, choices] of Object.entries(DRAIN_POLICY_CHOICES)) {
    const declared = overrides[key];
    policy[key] = choices.includes(declared) ? declared : 'refuse';
  }
  return policy;
}

/** Pods that legitimately stay on a draining node. */
function isDaemonSetPod(pod) {
  return (pod?.metadata?.ownerReferences || []).some((ref) => ref.kind === 'DaemonSet');
}

function isMirrorPod(pod) {
  return Boolean(pod?.metadata?.annotations?.['kubernetes.io/config.mirror']);
}

function isTerminal(pod) {
  return pod?.status?.phase === 'Succeeded' || pod?.status?.phase === 'Failed';
}

function isPodReady(pod) {
  return (pod?.status?.conditions || [])
    .some((condition) => condition.type === 'Ready' && condition.status === 'True');
}

/** The controller that would recreate a pod, if it has one. */
function controllerOf(pod) {
  const references = pod?.metadata?.ownerReferences || [];
  const owner = references.find((reference) => reference.controller) || references[0];
  return owner ? { kind: owner.kind, name: owner.name, uid: owner.uid || null } : null;
}

function sameController(reference, owner) {
  if (!reference || !owner) return false;
  if (owner.uid && reference.uid) return reference.uid === owner.uid;
  return reference.kind === owner.kind && reference.name === owner.name;
}

/**
 * Evaluates a Kubernetes label selector.
 *
 * Returns true, false, or null when the selector uses something this code does
 * not understand. A null must never be read as "does not match": an unknown
 * selector is a reason to refuse, because it may well be the budget that would
 * have stopped the drain.
 */
function matchesSelector(selector, labels = {}) {
  // policy/v1 treats an absent selector as selecting nothing and an empty one
  // as selecting everything. The difference is too consequential to guess at,
  // so an absent selector is reported as unknown.
  if (selector === undefined || selector === null) return null;
  if (typeof selector !== 'object') return null;

  const known = new Set(['matchLabels', 'matchExpressions']);
  for (const key of Object.keys(selector)) {
    if (!known.has(key)) return null;
  }

  for (const [key, value] of Object.entries(selector.matchLabels || {})) {
    if (labels[key] !== value) return false;
  }

  for (const expression of selector.matchExpressions || []) {
    const present = Object.prototype.hasOwnProperty.call(labels, expression.key);
    const values = Array.isArray(expression.values) ? expression.values : [];
    switch (expression.operator) {
      case 'In':
        if (!present || !values.includes(labels[expression.key])) return false;
        break;
      case 'NotIn':
        if (present && values.includes(labels[expression.key])) return false;
        break;
      case 'Exists':
        if (!present) return false;
        break;
      case 'DoesNotExist':
        if (present) return false;
        break;
      default:
        return null;
    }
  }
  return true;
}

/**
 * Decides whether a PodDisruptionBudget currently forbids evicting a pod.
 *
 * A budget only matters when it is in the pod's namespace and its selector
 * actually selects that pod. Treating every budget in the cluster as relevant
 * makes an unrelated saturated budget block maintenance forever, which trains
 * operators to bypass the check.
 */
function budgetVerdict(budget, pod) {
  if (budget?.metadata?.namespace !== pod?.metadata?.namespace) return { relevant: false };

  const matched = matchesSelector(budget?.spec?.selector, pod?.metadata?.labels || {});
  if (matched === null) {
    return {
      relevant: true,
      unknown: `${budget?.metadata?.namespace}/${budget?.metadata?.name} uses a selector this coordinator cannot evaluate`,
    };
  }
  if (matched === false) return { relevant: false };

  const status = budget.status || {};
  // A status that has not caught up with the spec describes the old budget.
  const generation = budget.metadata?.generation;
  if (generation !== undefined && status.observedGeneration !== undefined
    && Number(status.observedGeneration) < Number(generation)) {
    return {
      relevant: true,
      unknown: `${budget.metadata.namespace}/${budget.metadata.name} has a stale status and cannot be trusted`,
    };
  }
  if (typeof status.disruptionsAllowed !== 'number') {
    return {
      relevant: true,
      unknown: `${budget.metadata.namespace}/${budget.metadata.name} reports no disruptionsAllowed`,
    };
  }
  return {
    relevant: true,
    blocked: status.disruptionsAllowed <= 0,
    disruptionsAllowed: status.disruptionsAllowed,
  };
}

// ── resource arithmetic ──────────────────────────────────────────────────────

const BINARY_SUFFIX = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
const DECIMAL_SUFFIX = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const QUANTITY_RE = /^([0-9]+(?:\.[0-9]+)?)(?:(e[+-]?[0-9]+)|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]))?$/;

/**
 * Parses a Kubernetes resource quantity.
 *
 * Returns null for anything it does not fully understand, including negatives
 * and empty strings. Callers must treat null as "refuse", never as zero: a
 * quantity read as zero is a pod that appears to fit anywhere.
 */
function parseQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = QUANTITY_RE.exec(value.trim());
  if (!match) return null;
  const [, digits, exponent, suffix] = match;
  let result = Number(digits);
  if (!Number.isFinite(result)) return null;
  if (exponent) result *= 10 ** Number(exponent.slice(1));
  if (suffix) result *= BINARY_SUFFIX[suffix] ?? DECIMAL_SUFFIX[suffix];
  return Number.isFinite(result) ? result : null;
}

/** CPU as an integer count of millicores, so sums stay exact. */
function parseCpu(value) {
  const cores = parseQuantity(value);
  return cores === null ? null : Math.round(cores * 1000);
}

function parseMemory(value) {
  const bytes = parseQuantity(value);
  return bytes === null ? null : Math.round(bytes);
}

const ZERO = { cpu: 0, memory: 0 };

function addResources(left, right) {
  return { cpu: left.cpu + right.cpu, memory: left.memory + right.memory };
}

/** Reads one container's requests. Returns null if any quantity is unreadable. */
function containerRequests(container) {
  const requests = container?.resources?.requests || {};
  const cpu = requests.cpu === undefined ? 0 : parseCpu(requests.cpu);
  const memory = requests.memory === undefined ? 0 : parseMemory(requests.memory);
  if (cpu === null || memory === null) return null;
  return { cpu, memory };
}

/**
 * The requests the scheduler will actually reserve for a pod.
 *
 * Regular containers run concurrently, so their requests add up. Plain init
 * containers run one at a time before them, so only the largest matters.
 * Sidecar init containers (`restartPolicy: Always`) keep running alongside the
 * regular containers, so they add. The effective request is the larger of the
 * two shapes, which is what kube-scheduler computes.
 */
function podRequests(pod) {
  const spec = pod?.spec || {};
  let concurrent = ZERO;
  for (const container of spec.containers || []) {
    const requests = containerRequests(container);
    if (!requests) return null;
    concurrent = addResources(concurrent, requests);
  }

  let largestInit = ZERO;
  for (const container of spec.initContainers || []) {
    const requests = containerRequests(container);
    if (!requests) return null;
    if (container.restartPolicy === 'Always') {
      concurrent = addResources(concurrent, requests);
    } else {
      largestInit = {
        cpu: Math.max(largestInit.cpu, requests.cpu),
        memory: Math.max(largestInit.memory, requests.memory),
      };
    }
  }

  return {
    cpu: Math.max(concurrent.cpu, largestInit.cpu),
    memory: Math.max(concurrent.memory, largestInit.memory),
  };
}

/**
 * Whether a toleration covers a taint.
 *
 * An unrecognised operator returns null so the caller fails closed rather than
 * concluding the pod is untainted.
 */
function tolerates(toleration, taint) {
  if (toleration.effect && toleration.effect !== taint.effect) return false;
  switch (toleration.operator || 'Equal') {
    case 'Exists':
      // An empty key with Exists tolerates every taint.
      return !toleration.key || toleration.key === taint.key;
    case 'Equal':
      return toleration.key === taint.key && (toleration.value || '') === (taint.value || '');
    default:
      return null;
  }
}

/** Taints on a node that would stop this pod landing there. */
function taintVerdict(node, pod) {
  const tolerations = pod?.spec?.tolerations || [];
  for (const taint of node?.spec?.taints || []) {
    if (taint.effect === 'PreferNoSchedule') continue;
    if (taint.effect !== 'NoSchedule' && taint.effect !== 'NoExecute') {
      return { unknown: `${node.metadata.name} carries a taint with the unrecognised effect ${taint.effect}` };
    }
    let covered = false;
    for (const toleration of tolerations) {
      const verdict = tolerates(toleration, taint);
      if (verdict === null) {
        return { unknown: `a toleration uses the unrecognised operator ${toleration.operator}` };
      }
      if (verdict) { covered = true; break; }
    }
    if (!covered) return { blocked: `${taint.key}=${taint.value || ''}:${taint.effect}` };
  }
  return {};
}

/**
 * Scheduling constraints this coordinator cannot simulate.
 *
 * Rather than approximate them, it reports them so the reboot is refused. An
 * approximation that says "it fits" is indistinguishable from a correct answer
 * right up until the workload has nowhere to go.
 */
function unsupportedScheduling(pod) {
  const spec = pod?.spec || {};
  const affinity = spec.affinity || {};
  if (affinity.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution) {
    return 'required node affinity';
  }
  if (affinity.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution) {
    return 'required pod affinity';
  }
  if (affinity.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution) {
    return 'required pod anti-affinity';
  }
  if ((spec.topologySpreadConstraints || []).some((c) => c.whenUnsatisfiable === 'DoNotSchedule')) {
    return 'a topology spread constraint that must be satisfied';
  }
  if (spec.schedulerName && spec.schedulerName !== 'default-scheduler') {
    return `the custom scheduler ${spec.schedulerName}`;
  }
  return null;
}

/** Whether a node satisfies a pod's nodeSelector. */
function matchesNodeSelector(node, pod) {
  const selector = pod?.spec?.nodeSelector || {};
  const labels = node?.metadata?.labels || {};
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function nodeIsControlPlane(node) {
  const labels = node?.metadata?.labels || {};
  return Boolean(
    labels['node-role.kubernetes.io/control-plane'] !== undefined
    || labels['node-role.kubernetes.io/master'] !== undefined
    || labels['node-role.kubernetes.io/etcd'] !== undefined,
  );
}

/**
 * Identifies nodes that actually run an etcd member.
 *
 * The control-plane label is not evidence of etcd membership. A kubeadm cluster
 * with external etcd labels its API servers control-plane while etcd lives
 * elsewhere entirely; a K3s server can run embedded etcd, a shared SQL store,
 * or none of the above. Counting labels would produce a confident quorum number
 * that has nothing to do with the real membership, so membership is read from
 * artefacts that only exist when a member is really there:
 *
 *   - `node-role.kubernetes.io/etcd` (K3s embedded etcd, RKE)
 *   - `etcd.k3s.cattle.io/*` node annotations (K3s member metadata)
 *   - a static `etcd-<node>` pod in kube-system (kubeadm stacked etcd)
 */
function etcdMembers(nodes, kubeSystemPods) {
  const members = new Map();

  for (const node of nodes) {
    const name = node?.metadata?.name;
    if (!name) continue;
    const labels = node?.metadata?.labels || {};
    const annotations = node?.metadata?.annotations || {};
    if (labels['node-role.kubernetes.io/etcd'] !== undefined) {
      members.set(name, 'node-role.kubernetes.io/etcd label');
      continue;
    }
    const k3s = Object.keys(annotations).find((key) => key.startsWith('etcd.k3s.cattle.io/'));
    if (k3s) members.set(name, `${k3s} annotation`);
  }

  for (const pod of kubeSystemPods || []) {
    const nodeName = pod?.spec?.nodeName;
    if (!nodeName || members.has(nodeName)) continue;
    const isStatic = Boolean(pod?.metadata?.annotations?.['kubernetes.io/config.mirror']);
    const looksLikeEtcd = pod?.metadata?.name === `etcd-${nodeName}`
      || pod?.metadata?.labels?.component === 'etcd';
    if (isStatic && looksLikeEtcd) members.set(nodeName, `static pod ${pod.metadata.name}`);
  }

  return members;
}

function nodeCondition(node, type) {
  return (node?.status?.conditions || []).find((condition) => condition.type === type) || null;
}

function nodeReady(node) {
  return nodeCondition(node, 'Ready')?.status === 'True';
}

/** Conditions that mean the node is already unhealthy in a specific way. */
function pressureFindings(node) {
  const findings = [];
  for (const type of ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']) {
    if (nodeCondition(node, type)?.status === 'True') findings.push(type);
  }
  return findings;
}

/**
 * @param client  narrow Kubernetes client (injectable)
 * @param now     clock (injectable)
 */
function createMaintenanceCoordinator({
  client,
  now = () => Date.now(),
  logger = null,
  etcdTopology = process.env.RCC_ETCD_TOPOLOGY || '',
  drainPolicy = {
    daemonSetPods: process.env.RCC_DRAIN_DAEMONSET_PODS,
    staticPods: process.env.RCC_DRAIN_STATIC_PODS,
    emptyDirData: process.env.RCC_DRAIN_EMPTYDIR_DATA,
  },
  drainTimeoutMs = Number(process.env.RCC_DRAIN_TIMEOUT_MS) || DEFAULT_DRAIN_TIMEOUT_MS,
  pollIntervalMs = Number(process.env.RCC_DRAIN_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  const policy = resolveDrainPolicy(drainPolicy);
  function log(level, message, detail) {
    if (!logger) return;
    logger(JSON.stringify({ level, msg: message, ...detail }));
  }

  /**
   * Resolves the RCC Host to a Kubernetes Node.
   *
   * Matching is by node name first, then by the node's reported hostname label.
   * An ambiguous match is a refusal: acting on the wrong node is worse than not
   * acting.
   */
  async function resolveNode(hostId, snapshotHostname) {
    const nodes = await client.listNodes();
    if (!Array.isArray(nodes)) throw { code: 503, msg: 'cannot list Kubernetes nodes' };

    const candidates = nodes.filter((node) => {
      const name = node?.metadata?.name;
      if (!name) return false;
      if (name === hostId) return true;
      const hostname = node?.metadata?.labels?.['kubernetes.io/hostname'];
      if (hostname && hostname === hostId) return true;
      if (snapshotHostname) {
        if (name === snapshotHostname) return true;
        if (hostname && hostname === snapshotHostname) return true;
        // The snapshot hostname may be fully qualified while the node is short.
        const short = String(snapshotHostname).split('.')[0];
        if (short && (name === short || hostname === short)) return true;
      }
      return false;
    });

    if (candidates.length === 0) {
      throw { code: 409, msg: `host ${hostId} does not map to any Kubernetes node` };
    }
    if (candidates.length > 1) {
      throw {
        code: 409,
        msg: `host ${hostId} matches ${candidates.length} Kubernetes nodes; refusing to guess`,
      };
    }
    return candidates[0];
  }

  /**
   * Establishes what rebooting this node does to etcd.
   *
   * The topology must be declared, because it cannot be discovered reliably and
   * guessing it wrong is how a cluster loses quorum. The declaration is then
   * checked against what the cluster actually shows: a declaration that
   * contradicts the evidence is refused rather than believed.
   */
  async function assessEtcd({ node, nodeName, nodes, blocking, warnings }) {
    let kubeSystemPods = [];
    if (typeof client.listPodsInNamespace === 'function') {
      kubeSystemPods = await client.listPodsInNamespace('kube-system');
      if (!Array.isArray(kubeSystemPods)) throw { code: 503, msg: 'cannot list kube-system pods' };
    }
    const members = etcdMembers(nodes, kubeSystemPods);
    const memberNames = [...members.keys()].sort();
    const evidence = {
      topology: etcdTopology || 'undeclared',
      members: memberNames,
      memberEvidence: Object.fromEntries(members),
      memberOfCluster: members.has(nodeName),
    };

    if (!ETCD_TOPOLOGIES.has(etcdTopology)) {
      blocking.push({
        code: 'etcd-topology-unknown',
        detail: `${nodeName} is a control-plane node but the etcd topology is not declared; set RCC_ETCD_TOPOLOGY to "stacked" or "external" so quorum can be reasoned about instead of guessed`,
      });
      return evidence;
    }

    if (etcdTopology === 'external') {
      if (members.size > 0) {
        blocking.push({
          code: 'etcd-topology-contradiction',
          detail: `etcd is declared external, but ${memberNames.join(', ')} carries etcd member evidence; resolve the contradiction before rebooting`,
        });
      }
      return evidence;
    }

    // stacked
    if (members.size === 0) {
      blocking.push({
        code: 'etcd-topology-contradiction',
        detail: 'etcd is declared stacked, but no node carries etcd member evidence; the declaration cannot be verified',
      });
      return evidence;
    }
    if (!members.has(nodeName)) {
      // An API-server-only control-plane node. Quorum is untouched.
      return evidence;
    }

    const total = members.size;
    const remaining = memberNames
      .filter((name) => name !== nodeName)
      .filter((name) => nodeReady(nodes.find((candidate) => candidate.metadata?.name === name)))
      .length;
    const quorum = Math.floor(total / 2) + 1;
    if (total <= 1) {
      blocking.push({
        code: 'sole-etcd-member',
        detail: `${nodeName} is the only etcd member; rebooting it loses the cluster datastore`,
      });
    } else if (remaining < quorum) {
      blocking.push({
        code: 'etcd-quorum',
        detail: `rebooting ${nodeName} leaves ${remaining} of ${total} etcd members Ready, below the quorum of ${quorum}`,
      });
    } else if (total % 2 === 0) {
      warnings.push({
        code: 'etcd-even-membership',
        detail: `etcd has ${total} members; an even membership tolerates no more failures than ${total - 1} would`,
      });
    }
    return evidence;
  }

  /**
   * Decides whether the rest of the cluster can actually take this node's work.
   *
   * "Another node is Ready" is not an answer. A Ready node that is cordoned,
   * tainted against these pods, or already committed to within a few hundred
   * megabytes of its allocatable will not receive them, and the workload simply
   * stops. So this simulates the placement: free capacity is allocatable minus
   * the requests already committed on that node, and each evicted pod must have
   * somewhere it genuinely fits.
   *
   * Anything that cannot be computed is a refusal, never an assumption.
   */
  async function assessCapacity({ nodeName, nodes, candidates, blocking, warnings }) {
    if (typeof client.listAllPods !== 'function') {
      blocking.push({
        code: 'capacity-unknown',
        detail: 'cluster-wide pod requests are unavailable, so remaining capacity cannot be established',
      });
      return { computed: false };
    }
    const allPods = await client.listAllPods();
    if (!Array.isArray(allPods)) throw { code: 503, msg: 'cannot list cluster pods' };

    // Free capacity per candidate target node.
    const free = new Map();
    const rejected = [];
    for (const node of nodes) {
      const name = node?.metadata?.name;
      if (!name || name === nodeName) continue;
      if (!nodeReady(node)) { rejected.push({ node: name, reason: 'not Ready' }); continue; }
      if (node.spec?.unschedulable) { rejected.push({ node: name, reason: 'cordoned' }); continue; }

      const allocatable = node.status?.allocatable || {};
      const cpu = parseCpu(allocatable.cpu);
      const memory = parseMemory(allocatable.memory);
      if (cpu === null || memory === null) {
        blocking.push({
          code: 'capacity-unknown',
          detail: `${name} does not report readable allocatable cpu and memory, so its free capacity is unknown`,
        });
        return { computed: false };
      }

      let committed = ZERO;
      for (const pod of allPods) {
        if (pod?.spec?.nodeName !== name || isTerminal(pod)) continue;
        const requests = podRequests(pod);
        if (!requests) {
          blocking.push({
            code: 'capacity-unknown',
            detail: `${pod?.metadata?.namespace}/${pod?.metadata?.name} on ${name} has unreadable resource requests`,
          });
          return { computed: false };
        }
        committed = addResources(committed, requests);
      }
      free.set(name, { cpu: cpu - committed.cpu, memory: memory - committed.memory });
    }

    if (free.size === 0) {
      blocking.push({
        code: 'no-capacity',
        detail: rejected.length
          ? `no node can receive this workload: ${rejected.map((entry) => `${entry.node} is ${entry.reason}`).join(', ')}`
          : 'no other node is available to receive evicted workloads',
      });
      return { computed: true, targets: [], placements: [] };
    }

    // Place the largest pods first: a greedy fit that starts small can claim the
    // only node big enough for the pod it has not looked at yet.
    const ordered = [...candidates].map((pod) => ({ pod, requests: podRequests(pod) }))
      .sort((left, right) => (right.requests?.memory ?? 0) - (left.requests?.memory ?? 0)
        || (right.requests?.cpu ?? 0) - (left.requests?.cpu ?? 0));

    const placements = [];
    for (const { pod, requests } of ordered) {
      const label = `${pod.metadata.namespace}/${pod.metadata.name}`;
      if (!requests) {
        blocking.push({ code: 'capacity-unknown', detail: `${label} has unreadable resource requests` });
        return { computed: false };
      }
      const unsupported = unsupportedScheduling(pod);
      if (unsupported) {
        blocking.push({
          code: 'schedulability-unknown',
          detail: `${label} uses ${unsupported}; this coordinator cannot prove it would be rescheduled`,
        });
        continue;
      }
      if (requests.cpu === 0 && requests.memory === 0) {
        warnings.push({
          code: 'no-requests',
          detail: `${label} declares no resource requests, so its real footprint cannot be planned for`,
        });
      }

      let placed = null;
      const refusals = [];
      for (const node of nodes) {
        const name = node?.metadata?.name;
        if (!free.has(name)) continue;
        if (!matchesNodeSelector(node, pod)) { refusals.push(`${name}: nodeSelector`); continue; }
        const taint = taintVerdict(node, pod);
        if (taint.unknown) {
          blocking.push({ code: 'schedulability-unknown', detail: `${label}: ${taint.unknown}` });
          return { computed: false };
        }
        if (taint.blocked) { refusals.push(`${name}: taint ${taint.blocked}`); continue; }
        const remaining = free.get(name);
        if (remaining.cpu < requests.cpu || remaining.memory < requests.memory) {
          refusals.push(`${name}: insufficient capacity`);
          continue;
        }
        free.set(name, { cpu: remaining.cpu - requests.cpu, memory: remaining.memory - requests.memory });
        placed = name;
        break;
      }

      if (!placed) {
        blocking.push({
          code: 'insufficient-capacity',
          detail: `${label} (${requests.cpu}m cpu, ${requests.memory} bytes) has nowhere to go — ${refusals.join('; ')}`,
        });
      } else {
        placements.push({ pod: label, node: placed });
      }
    }

    return {
      computed: true,
      targets: [...free.keys()],
      placements,
      remaining: Object.fromEntries(free),
      unusable: rejected,
    };
  }

  /**
   * Runs every preflight check and returns structured findings.
   *
   * `allowed` is true only when there are no blocking findings at all.
   */
  async function preflight(hostId, snapshotHostname) {
    const node = await resolveNode(hostId, snapshotHostname);
    const nodeName = node.metadata.name;
    const nodes = await client.listNodes();
    const blocking = [];
    const warnings = [];

    const ready = nodeReady(node);
    if (!ready) {
      // A NotReady node may be mid-recovery; rebooting can make diagnosis harder.
      blocking.push({
        code: 'node-not-ready',
        detail: `node ${nodeName} is not Ready; resolve its condition before rebooting`,
      });
    }
    const pressures = pressureFindings(node);
    for (const pressure of pressures) {
      warnings.push({ code: 'node-pressure', detail: `${nodeName} reports ${pressure}` });
    }

    const controlPlane = nodeIsControlPlane(node);
    const controlPlaneNodes = nodes.filter(nodeIsControlPlane);
    const readyControlPlane = controlPlaneNodes.filter(nodeReady);
    const readyWorkers = nodes.filter((candidate) => nodeReady(candidate) && candidate.metadata.name !== nodeName);

    // A single-node cluster cannot survive its only node rebooting.
    if (nodes.length <= 1) {
      blocking.push({
        code: 'single-node-cluster',
        detail: 'this is a single-node cluster; a normal governed reboot is refused because there is nowhere to move workloads',
      });
    }

    let etcd = { topology: etcdTopology || 'undeclared', members: [], memberOfCluster: false };
    if (controlPlane) {
      // Losing the last API server takes the cluster down regardless of where
      // etcd runs, so this check is independent of the topology question.
      if (readyControlPlane.filter((candidate) => candidate.metadata.name !== nodeName).length === 0) {
        blocking.push({
          code: 'sole-control-plane',
          detail: controlPlaneNodes.length <= 1
            ? 'this is the only control-plane node; rebooting it would take the cluster API down'
            : 'every other control-plane node is already NotReady; rebooting this one would take the cluster API down',
        });
      }
      etcd = await assessEtcd({ node, nodeName, nodes, blocking, warnings });
    }

    // Workload evictability.
    const pods = await client.listPodsOnNode(nodeName);
    if (!Array.isArray(pods)) throw { code: 503, msg: 'cannot list pods for the node' };
    if (pods.length > MAX_PODS) {
      blocking.push({
        code: 'too-many-pods',
        detail: `node runs ${pods.length} pods, above the ${MAX_PODS} the coordinator will drain`,
      });
    }

    const evictable = [];
    const candidates = [];
    const leftInPlace = [];
    for (const pod of pods) {
      if (isTerminal(pod)) continue;
      const label = `${pod.metadata.namespace}/${pod.metadata.name}`;

      // Pods that will not be evicted at all. Each needs a declared decision,
      // because leaving one behind means the node is not really drained.
      if (isDaemonSetPod(pod)) {
        if (policy.daemonSetPods === 'leave-in-place') {
          leftInPlace.push({ pod: label, reason: 'DaemonSet pod, re-created by its controller after the reboot' });
        } else {
          blocking.push({
            code: 'daemonset-pod',
            detail: `${label} belongs to a DaemonSet and cannot be evicted; set RCC_DRAIN_DAEMONSET_PODS=leave-in-place to accept that it restarts in place`,
          });
        }
        continue;
      }
      if (isMirrorPod(pod)) {
        if (policy.staticPods === 'leave-in-place') {
          leftInPlace.push({ pod: label, reason: 'static pod, restarted by the kubelet after the reboot' });
        } else {
          blocking.push({
            code: 'static-pod',
            detail: `${label} is a static pod and cannot be evicted through the API; set RCC_DRAIN_STATIC_PODS=leave-in-place to accept that it restarts in place`,
          });
        }
        continue;
      }

      // A pod with no controller is not rescheduled by anything. There is no
      // policy that makes deleting it safe, so this is never overridable.
      if (!(pod.metadata?.ownerReferences || []).length) {
        blocking.push({
          code: 'unmanaged-pod',
          detail: `${label} has no controller and would not be rescheduled`,
        });
        continue;
      }

      const emptyDirs = (pod.spec?.volumes || []).filter((volume) => volume.emptyDir !== undefined);
      const durableEmptyDirs = emptyDirs.filter((volume) => volume.emptyDir?.medium !== 'Memory');
      if (durableEmptyDirs.length) {
        if (policy.emptyDirData === 'accept-data-loss') {
          warnings.push({
            code: 'local-storage',
            detail: `${label} uses emptyDir; its data will be lost, which policy has accepted`,
          });
        } else {
          blocking.push({
            code: 'local-storage-data',
            detail: `${label} keeps data in emptyDir that the move destroys; set RCC_DRAIN_EMPTYDIR_DATA=accept-data-loss to allow it`,
          });
          continue;
        }
      }

      // Volumes pinned to this machine cannot follow the pod anywhere.
      const pinned = (pod.spec?.volumes || []).find((volume) => volume.hostPath !== undefined);
      if (pinned) {
        blocking.push({
          code: 'node-pinned-storage',
          detail: `${label} mounts the hostPath ${pinned.hostPath?.path}; its data cannot move to another node`,
        });
        continue;
      }

      evictable.push({
        namespace: pod.metadata.namespace,
        name: pod.metadata.name,
        uid: pod.metadata.uid || null,
        controller: controllerOf(pod),
      });
      candidates.push(pod);
    }

    const capacity = await assessCapacity({ nodeName, nodes, candidates, blocking, warnings });

    // PodDisruptionBudgets, evaluated only against the pods actually being
    // evicted from this node.
    const budgets = await client.listPodDisruptionBudgets();
    if (!Array.isArray(budgets)) throw { code: 503, msg: 'cannot list pod disruption budgets' };
    for (const candidate of candidates) {
      for (const budget of budgets) {
        const verdict = budgetVerdict(budget, candidate);
        if (!verdict.relevant) continue;
        if (verdict.unknown) {
          blocking.push({ code: 'pdb-unknown', detail: verdict.unknown });
          continue;
        }
        if (verdict.blocked) {
          blocking.push({
            code: 'pdb-blocked',
            detail: `${budget.metadata.namespace}/${budget.metadata.name} allows no disruptions and covers ${candidate.metadata.namespace}/${candidate.metadata.name}`,
          });
        }
      }
    }

    return {
      node: nodeName,
      ready,
      controlPlane,
      pressures,
      nodeCount: nodes.length,
      readyWorkerCount: readyWorkers.length,
      controlPlaneCount: controlPlaneNodes.length,
      etcd,
      podCount: pods.length,
      capacity,
      leftInPlace,
      drainPolicy: policy,
      evictable,
      blocking,
      warnings,
      allowed: blocking.length === 0,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  /** Cordons the node so the scheduler stops placing new work on it. */
  async function cordon(nodeName) {
    await client.patchNodeUnschedulable(nodeName, true);
    log('info', 'node cordoned', { node: nodeName });
    return { cordoned: true, at: new Date(now()).toISOString() };
  }

  /** Uncordons the node, restoring scheduling. Safe to call repeatedly. */
  async function uncordon(nodeName) {
    await client.patchNodeUnschedulable(nodeName, false);
    log('info', 'node uncordoned', { node: nodeName });
    return { cordoned: false, at: new Date(now()).toISOString() };
  }

  /** Polls a condition a bounded number of times. Never loops forever. */
  async function waitUntil(check, label) {
    const attempts = Math.max(1, Math.ceil(drainTimeoutMs / pollIntervalMs));
    const deadline = now() + drainTimeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      if (await check()) return true;
      if (attempt >= attempts || now() > deadline) {
        log('warn', 'timed out waiting', { for: label });
        return false;
      }
      await sleep(pollIntervalMs);
    }
  }

  /** Whether a pod has actually left the node, as opposed to been asked to. */
  async function podHasLeft(pod, nodeName) {
    let current;
    try {
      current = await client.getPod(pod.namespace, pod.name);
    } catch (error) {
      if (error?.code === 404) return true;
      throw error;
    }
    if (!current) return true;
    // A same-named pod recreated elsewhere is a different pod.
    if (pod.uid && current.metadata?.uid && current.metadata.uid !== pod.uid) return true;
    return current.spec?.nodeName !== nodeName;
  }

  /** Whether the controller has a Ready replacement running somewhere else. */
  async function replacementIsReady(pod, nodeName) {
    const all = await client.listAllPods();
    if (!Array.isArray(all)) throw { code: 503, msg: 'cannot list cluster pods' };
    return all.some((candidate) => candidate?.metadata?.namespace === pod.namespace
      && candidate?.metadata?.uid !== pod.uid
      && candidate?.spec?.nodeName
      && candidate.spec.nodeName !== nodeName
      && (candidate.metadata?.ownerReferences || [])
        .some((reference) => sameController(reference, pod.controller))
      && isPodReady(candidate));
  }

  /**
   * Drains via the eviction API so PodDisruptionBudgets are respected.
   *
   * Deleting pods directly would bypass budgets entirely; that is the whole
   * reason eviction exists. A 429 means a budget refused this eviction right
   * now, which is a legitimate reason to stop and retry later rather than to
   * force the issue.
   *
   * A 201 from the eviction API means the request was accepted, not that the
   * workload has moved. Reporting success there would let the reboot proceed
   * while pods are still terminating and their replacements have not started,
   * which is the outage the drain exists to prevent. So each pod is followed
   * until it has actually left, and then until its controller has a Ready
   * replacement elsewhere. Anything still outstanding when the clock runs out
   * is a refusal.
   */
  async function drain(nodeName, pods) {
    const evicted = [];
    const refused = [];

    for (const pod of pods) {
      const label = `${pod.namespace}/${pod.name}`;
      try {
        await client.evictPod(pod.namespace, pod.name, EVICTION_API_VERSION);
      } catch (error) {
        refused.push({
          pod: label,
          reason: error?.code === 429
            ? 'a PodDisruptionBudget currently forbids this eviction'
            : (error?.msg || 'eviction failed'),
        });
        continue;
      }
      const left = await waitUntil(() => podHasLeft(pod, nodeName), `${label} to leave ${nodeName}`);
      if (!left) {
        refused.push({ pod: label, reason: 'the eviction was accepted but the pod is still on this node' });
        continue;
      }
      evicted.push(label);
    }

    if (refused.length) {
      return { drained: false, evicted, refused, replacementsReady: false, at: new Date(now()).toISOString() };
    }

    const pending = [];
    for (const pod of pods) {
      const label = `${pod.namespace}/${pod.name}`;
      if (!pod.controller) {
        pending.push({ pod: label, reason: 'the pod has no controller, so no replacement can be confirmed' });
        continue;
      }
      const ready = await waitUntil(
        () => replacementIsReady(pod, nodeName),
        `a Ready replacement for ${label}`,
      );
      if (!ready) {
        pending.push({ pod: label, reason: 'no replacement became Ready on another node' });
      }
    }

    if (pending.length) {
      return {
        drained: false,
        evicted,
        refused: pending,
        replacementsReady: false,
        at: new Date(now()).toISOString(),
      };
    }
    return { drained: true, evicted, refused, replacementsReady: true, at: new Date(now()).toISOString() };
  }

  /**
   * Puts a node back into service after a failed preparation.
   *
   * If this fails the node stays cordoned, which is a real and invisible
   * degradation: the scheduler quietly stops using a healthy machine and
   * nothing says so. Swallowing the error is therefore not an option — it is
   * returned as evidence for the caller to persist and a reconciler to retry.
   */
  async function restoreScheduling(nodeName) {
    try {
      await uncordon(nodeName);
      return { cordon: { cordoned: false, restoredAt: new Date(now()).toISOString() } };
    } catch (error) {
      const degraded = {
        code: 'uncordon-failed',
        node: nodeName,
        detail: `${nodeName} could not be returned to service and is still cordoned: ${String(error?.msg || error?.message || error)}`,
        at: new Date(now()).toISOString(),
      };
      log('error', 'uncordon failed; node left cordoned', { node: nodeName, error: degraded.detail });
      return { cordon: { cordoned: true }, degraded };
    }
  }

  /**
   * Full preparation: preflight, cordon, drain.
   *
   * On any failure after cordoning, the node is uncordoned again so a refused
   * preparation does not silently leave the cluster degraded.
   */
  async function prepare(hostId, snapshotHostname) {
    const findings = await preflight(hostId, snapshotHostname);
    if (!findings.allowed) {
      return { prepared: false, ...findings };
    }
    const cordonResult = await cordon(findings.node);
    try {
      const drainResult = await drain(findings.node, findings.evictable);
      if (!drainResult.drained) {
        const restored = await restoreScheduling(findings.node);
        return { prepared: false, ...findings, ...restored, drain: drainResult };
      }
      return { prepared: true, ...findings, cordon: cordonResult, drain: drainResult };
    } catch (error) {
      const restored = await restoreScheduling(findings.node);
      // Carry the degradation out with the failure; it must not be lost just
      // because something else went wrong first.
      if (restored.degraded) error.degraded = restored.degraded;
      error.node = findings.node;
      throw error;
    }
  }

  return { resolveNode, preflight, cordon, drain, uncordon, restoreScheduling, prepare };
}

/**
 * In-cluster adapter over the Kubernetes API.
 *
 * Kept deliberately thin: it knows how to authenticate and how to shape five
 * specific requests, and nothing else. It is not a general proxy.
 */
function createInClusterMaintenanceClient({
  apiServer = `https://${process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc'}:${process.env.KUBERNETES_SERVICE_PORT || 443}`,
  readToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  fieldSelectorLimit = 500,
  clusterPodLimit = 5000,
} = {}) {
  async function call(path, { method = 'GET', body = undefined } = {}) {
    const response = await fetchImpl(`${apiServer}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${readToken()}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(method === 'PATCH' ? { 'content-type': 'application/strategic-merge-patch+json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw { code: response.status, msg: `kubernetes ${method} ${path} failed with ${response.status}` };
    }
    return text ? JSON.parse(text) : {};
  }

  return {
    async listNodes() {
      const result = await call('/api/v1/nodes?limit=500');
      return result.items || [];
    },
    async listPodsOnNode(nodeName) {
      const selector = encodeURIComponent(`spec.nodeName=${nodeName}`);
      const result = await call(`/api/v1/pods?fieldSelector=${selector}&limit=${fieldSelectorLimit}`);
      return result.items || [];
    },
    async listPodsInNamespace(namespace) {
      const result = await call(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=${fieldSelectorLimit}`,
      );
      return result.items || [];
    },
    /**
     * Every pod in the cluster, used to work out how much room each node has
     * left. A truncated page would understate the committed requests and make a
     * full node look empty, so a continuation token is an error rather than a
     * partial answer.
     */
    async listAllPods() {
      const result = await call(`/api/v1/pods?limit=${clusterPodLimit}`);
      if (result.metadata?.continue) {
        throw { code: 507, msg: `the cluster has more than ${clusterPodLimit} pods; capacity cannot be computed safely` };
      }
      return result.items || [];
    },
    async getPod(namespace, name) {
      try {
        return await call(
          `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`,
        );
      } catch (error) {
        if (error?.code === 404) return null;
        throw error;
      }
    },
    async listPodDisruptionBudgets() {
      const result = await call(`/apis/policy/v1/poddisruptionbudgets?limit=${fieldSelectorLimit}`);
      return result.items || [];
    },
    async patchNodeUnschedulable(nodeName, unschedulable) {
      return call(`/api/v1/nodes/${encodeURIComponent(nodeName)}`, {
        method: 'PATCH',
        body: { spec: { unschedulable: Boolean(unschedulable) } },
      });
    },
    async evictPod(namespace, name, apiVersion) {
      return call(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/eviction`,
        {
          method: 'POST',
          body: {
            apiVersion,
            kind: 'Eviction',
            metadata: { name, namespace },
          },
        },
      );
    },
  };
}

module.exports = {
  MAX_PODS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DRAIN_POLICY_CHOICES,
  resolveDrainPolicy,
  parseQuantity,
  podRequests,
  matchesSelector,
  budgetVerdict,
  etcdMembers,
  createMaintenanceCoordinator,
  createInClusterMaintenanceClient,
  nodeIsControlPlane,
  nodeReady,
  isDaemonSetPod,
};
