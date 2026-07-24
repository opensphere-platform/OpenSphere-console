import { Observable } from 'rxjs';

/**
 * C2 타입 정본(SSOT) — ADR-UI-004 D3 / P6-no-yaml-control-P0 §3.2.
 * 모든 쓰기는 MutationIntent로 표현되어 단일 관문(MutationService)을 통과한다.
 * 다른 컴포넌트는 이 타입을 import만 한다(중복 정의 금지).
 */
export type RiskLevel = 'green' | 'yellow' | 'red';

export type MutationVerb =
  | 'create'
  | 'patchMerge'
  | 'patchStrategic'
  | 'replace' // 사람 YAML 편집(saveEdit)에서만 허용. 폼·AI 금지(전략 §3.4)
  | 'remove'
  | 'action'; // 서브리소스 POST(eviction 등). 'delete' 명칭은 폐기

/** SelfSubjectAccessReview resourceAttributes. */
export interface SarAttrs {
  group: string;
  resource: string;
  verb: string;
  namespace?: string;
  name?: string;
  subresource?: string;
}

/** 위험도 산정 신호(화면이 읽기 데이터로 best-effort 채움). 누락 시 보수적 상향. */
export interface MutationSignals {
  targetsPersistentData?: boolean; // PVC/PV·reclaimPolicy≠Retain → 데이터 소실
  affectsAvailability?: boolean;   // 마지막 인스턴스/PDB 위반/replica 0
  cascadeRefs?: number;            // 참조 Service/Ingress·owner 자식 수
  envLabel?: 'prod' | 'protected' | 'normal';
}

export interface MutationIntent<T = any> {
  verb: MutationVerb;
  /** create: '<apiRoot>/namespaces/<ns>/<plural>' / 그 외: singleResourcePath(). 쿼리 없이. */
  path: string;
  body?: any;
  /** 사람말 1줄 요약(green=요약만 노출). */
  summary: string;
  /** diff·undo 스냅샷 원천 = 화면 obj() signal. */
  before?: T;
  signals?: MutationSignals;
  /** 없으면 path에서 파생(sarFromPath). */
  sar?: SarAttrs;
}

export interface DryRunResult { ok: boolean; applied?: any; error?: string; }
export interface MutationDiff { path: string; before: any; after: any; kind: 'add' | 'remove' | 'change'; }

export interface MutationPlan {
  intent: MutationIntent;
  risk: RiskLevel;
  reasons: string[];
  sarAllowed: boolean;
  dryRun: DryRunResult;
  diff: MutationDiff[];
  confirmTier: 'toast' | 'modal' | 'modal+type';
}

export interface UndoHandle { label: string; run(): Observable<any>; }
export interface MutationOutcome { ok: boolean; result?: any; error?: string; undo?: UndoHandle; }
