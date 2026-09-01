import type { Capability } from './capabilities.js';

/* ── 기여 페이로드(contribution payloads) ─────────────────────────── */

/** 페이지 등록(page:register). elementTag = 셸이 라우트에 마운트할 custom element 태그. */
export interface PluginPage {
  id: string;
  title: string;
  navBand: string;
  elementTag: string;
}

/** 재귀 내비 노드(nav:contribute). 1:1 메뉴 = children 없는 노드 1개(특수 경우). */
export interface NavNode {
  id: string;
  label: string;
  /** 리프 선택 시 이동 경로. 셸 라우트 또는 #해시 deep-link. */
  route?: string;
  children?: NavNode[];
}

/** 알림 심각도(셸 인박스 모델과 동일). */
export type OsSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * 알림 발행 페이로드(notify:publish). id·source·read는 host가 채운다(time 생략 시 now).
 * 셸 내부 인박스 모델 OsNotification = NotifyInput & { id, source, read, time }.
 */
export interface NotifyInput {
  title: string;
  severity: OsSeverity;
  /** true=인박스 적재 / false=토스트(일시) */
  persistent: boolean;
  category?: string;
  detail?: string;
  route?: string;
  topic?: string;
  dedupKey?: string;
  actions?: { label: string; route?: string }[];
  time?: string;
}

/** 검색 결과 1건. provider 결과는 source=pluginId로 host가 태깅. */
export interface SearchResult {
  label: string;
  sublabel: string;
  path: string;
  kind: 'page' | 'plugin' | 'workspace' | 'result';
  source?: string;
}

/**
 * 검색 provider — 동기 또는 비동기(Promise). 두 federation 모드가 같은 인터페이스를 쓴다(C7):
 *   런타임 기여(search:contribute, 클라이언트 콘텐츠) · 데이터층(OpenSearch 등 백엔드 질의).
 */
export interface SearchProvider {
  query(q: string): SearchResult[] | Promise<SearchResult[]>;
}

export interface ManualContributionDocument {
  id: string;
  title: string;
  content: string;
  route?: string;
  sourcePath?: string;
  documentType?: string;
  tags?: string[];
}

export interface ManualSourceContribution {
  sourceId: string;
  name: string;
  authorityTier: number;
  language: 'ko' | 'en' | 'mixed';
  documents: ManualContributionDocument[];
}

/** 읽기전용 정체성(identity:read, 예약). 토큰은 host 소유 — guest는 토큰을 못 가진다. */
export interface IdentityView {
  username: string;
  groups: string[];
  roles: string[];
  /** 어느 기반의 정체성인가(dual-foundation): 콘솔 관리자(Kanidm) vs 워크스페이스 사원(Keycloak). */
  foundation: 'console' | 'workspace';
}

/** Main Shell이 소유하는 subShell deep-link 경계. guest는 window.history를 직접 소유하지 않는다. */
export interface RoutingContext {
  readonly basePath: string;
  currentPath(): string;
  navigate(path: string, options?: { replace?: boolean }): void;
  subscribe(listener: (path: string) => void): () => void;
}

/**
 * Host가 서명 manifest의 해시와 대조한 바이트만 노출하는 자산 로더.
 * guest는 동일 자산을 별도 <script>/<link> URL로 다시 가져오지 않는다.
 */
export interface VerifiedAssetContext {
  loadModule(id: string): Promise<unknown>;
  loadStyle(id: string): Promise<void>;
}

export interface OperatorSessionIntent {
  networkProfile: 'console-only';
}

export interface OperatorSessionView {
  sessionId: string;
  sessionClass: 'operator-interactive';
  runtimeAdapterId: 'cbss.kubernetes-pod';
  generation: number;
  fencingEpoch: number;
  desiredState: string;
  observedState: string;
  expiresAt: string;
}

export type PtyClientFrame =
  | { type: 'stdin'; sequence: number; data: string }
  | { type: 'resize'; sequence: number; cols: number; rows: number }
  | { type: 'ping'; sequence: number }
  | { type: 'detach'; sequence: number };

export type PtyServerFrame =
  | { type: 'attached'; sequence: number; sessionId: string }
  | { type: 'stdout' | 'stderr'; sequence: number; data: string }
  | { type: 'exit'; sequence: number; code: number }
  | { type: 'pong'; sequence: number }
  | { type: 'error' | 'revoked'; sequence: number; code: string; message: string };

export interface SessionAttachHandle {
  readonly sessionId: string;
  send(frame: PtyClientFrame): void;
  close(): void;
  subscribe(listener: (frame: PtyServerFrame) => void): () => void;
}

/** session:attach — ticket, WSS admission and revalidation remain Host-owned. */
export interface SessionAttachClient {
  create(intent: OperatorSessionIntent): Promise<OperatorSessionView>;
  get(sessionId: string): Promise<OperatorSessionView>;
  terminate(sessionId: string): Promise<void>;
  attach(sessionId: string): Promise<SessionAttachHandle>;
}

/* ── C2: Host Context ─────────────────────────────────────────────── */

/**
 * guest(plugin/subShell)가 activate()에서 받는 능력 표면.
 * 능력은 **부여된 capability에 따라 선택적으로 존재**한다(최소권한 — 미부여 능력은 undefined).
 * shellVersion으로 호환을 확인하고, grants로 자기에게 무엇이 허용됐는지 알 수 있다.
 */
export interface OpenSpherePluginContext {
  readonly pluginId: string;
  readonly shellVersion: string;
  readonly hostApiVersion: string;
  /** 이 guest에게 실제 부여된 capability 목록(검증·디버깅용). */
  readonly grants: readonly Capability[];

  /** 모든 guest에 제공되는 host-owned routing seam. `/p/<id>/*` 밖 이동은 거부된다. */
  readonly routing: RoutingContext;

  /** manifest.assets가 선언된 guest에만 제공되는 host-owned 무결성 로더. */
  assets?: VerifiedAssetContext;

  /** api:proxy */
  api?: {
    readonly baseUrl: string;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };

  /** notify:publish — 셸 단일 인박스에 발행(출처 자동 태깅). */
  notify?: {
    publish(input: NotifyInput): string;
    dismiss(id: string): void;
    clear(): void;
  };

  /** identity:read(예약) — 읽기전용 정체성. */
  identity?: IdentityView;

  /** session:attach — high-risk, default-off Host capability. */
  session?: SessionAttachClient;

  extensions: {
    /** page:register */
    registerPage?(p: PluginPage): void;
    /** nav:contribute */
    nav?: { contribute(tree: NavNode[]): void; clear(): void };
    /** search:contribute */
    search?: { contribute(provider: SearchProvider): void; clear(): void };
    /** manual:contribute */
    manual?: { contribute(source: ManualSourceContribution): void; clear(): void };
  };
}

/**
 * C3 — subShell 컨텍스트(1급 host-guest). plugin 컨텍스트에 **자식 호스팅** 능력을 더한다.
 * subShell은 자기 자식 plugin을 로드/집계하고, 그들의 기여를 자기 표면에 모은 뒤
 * (선택적으로) mainShell로 승격한다. 자식에 대한 신뢰·권한은 subShell이 매개한다.
 */
export interface OpenSphereSubShellContext extends OpenSpherePluginContext {
  host: {
    /** 자식 plugin manifest를 로드해 이 subShell 표면에 집계(7단 신뢰사슬 재적용). */
    mountChild(manifestUrl: string): Promise<void>;
    children(): readonly string[];
  };
}

/**
 * guest entry 모듈 계약 — renderMode:'esm'일 때 자기완결 단일 ESM이 export하는 형태.
 * (renderMode:'federation'은 무거운 subShell의 opt-in — 별도 remote 계약.)
 */
export interface PluginModule {
  activate(ctx: OpenSpherePluginContext): unknown;
  deactivate?(): void;
}
