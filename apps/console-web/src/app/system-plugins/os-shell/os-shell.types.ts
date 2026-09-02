import type { OperatorSessionView } from '@opensphere/console-contracts';

export type OsShellReadinessState = 'Disabled' | 'Checking' | 'Blocked' | 'Ready';
export type OsShellAttachState =
  | 'Idle'
  | 'Checking'
  | 'Attaching'
  | 'Attached'
  | 'Reconnecting'
  | 'Revoked'
  | 'Terminating'
  | 'Terminated'
  | 'Failed';

export interface OsShellBlocker {
  readonly code: string;
  readonly message: string;
  readonly nextAction: string;
  readonly owner: string;
}

export interface OsShellReleaseEvidence {
  readonly runtimeImageDigest?: string;
  readonly osArtifactDigest?: string;
  readonly releaseEvidenceRef?: string;
  readonly sessionPolicyRevision?: string;
}

export interface OsShellReadiness {
  readonly state: OsShellReadinessState;
  readonly authorized: boolean;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly observedAt: string;
  readonly freshness: 'fresh' | 'stale' | 'missing';
  readonly sessionClass: 'operator-interactive';
  readonly runtimeAdapterId: 'cbss.kubernetes-pod';
  readonly networkProfile: 'console-only';
  readonly blocker: OsShellBlocker | null;
  readonly release: OsShellReleaseEvidence;
}

export interface OsShellSession extends OperatorSessionView {
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly idleExpiresAt?: string;
  readonly release?: OsShellReleaseEvidence;
}

export interface OsShellAttachTicket {
  readonly ticket: string;
  readonly expiresAt: string;
  readonly protocol: 'opensphere.pty.v1';
  readonly sessionId: string;
  readonly generation: number;
  readonly fencingEpoch: number;
}

export interface OsShellFrameMessage {
  readonly contract: 'opensphere.shell.frame/v1';
  readonly type: string;
  readonly sequence?: number;
  readonly data?: string;
  readonly cols?: number;
  readonly rows?: number;
}
