import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { FFlowModule, provideFFlow, EFConnectableSide } from '@foblex/flow';

/**
 * os-backbone-graph — Backbone 의존 관계 인터랙티브 그래프(Foblex Flow).
 * 노드 = 콘솔 서비스 + Backbone 데이터티어, 엣지 = 연결 매트릭스(docs/BACKBONE-ARCHITECTURE.md §1.4) + 빌드 DAG(§5.1).
 * 데이터티어 노드(postgres/rustfs/gitea)는 라이브 readiness로 색을 입힌다(상태 = 부모가 status 맵으로 주입).
 * 드래그/줌 지원(f-flow fDraggable, f-canvas fZoom). 스크린은 이 컴포넌트만 보고 @foblex/* 직접 import 금지(파사드).
 */
interface GNode { id: string; label: string; sub: string; x: number; y: number; kind: 'service' | 'data' | 'planned'; statusKey?: string; }
interface GEdge { from: string; to: string; planned?: boolean; }

@Component({
  selector: 'os-backbone-graph',
  imports: [FFlowModule],
  providers: [provideFFlow()],
  template: `
    <div class="bb-graph">
      <f-flow fDraggable>
        <f-canvas fZoom>
          @for (n of nodes; track n.id) {
            <div
              fNode
              [fNodePosition]="{ x: n.x, y: n.y }"
              class="gnode"
              [class.k-service]="n.kind === 'service'"
              [class.k-data]="n.kind === 'data'"
              [class.k-planned]="n.kind === 'planned'"
              [class.s-ready]="isReady(n)"
              [class.s-notready]="isNotReady(n)"
            >
              <span class="dot" fNodeInput [fInputId]="n.id + '_in'" [fInputConnectableSide]="side.LEFT" [fInputMultiple]="true"></span>
              <span class="body">
                <strong>{{ n.label }}</strong>
                <span class="sub">{{ n.sub }}{{ statusText(n) }}</span>
              </span>
              <span class="dot" fNodeOutput [fOutputId]="n.id + '_out'" [fOutputConnectableSide]="side.RIGHT" [fOutputMultiple]="true"></span>
            </div>
          }
          @for (e of edges; track e.from + e.to) {
            <f-connection [fOutputId]="e.from + '_out'" [fInputId]="e.to + '_in'" [class.planned]="e.planned"></f-connection>
          }
        </f-canvas>
      </f-flow>

      <div class="legend">
        <span><i class="sw k-service"></i> 콘솔 서비스</span>
        <span><i class="sw k-data s-ready"></i> 데이터티어 (Ready)</span>
        <span><i class="sw k-data s-notready"></i> NotReady</span>
        <span><i class="sw k-planned"></i> 예정</span>
        <span class="hint">· 드래그로 이동, 휠로 줌</span>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* 콘솔은 라이트 테마(--os-surface-1=#f4f4f4·--os-ink=#161616). 그래프도 라이트로 통일.
         ⚠️ --os-fg·--os-surface-0·--os-border는 이 콘솔에 미정의 → 다크 fallback이 먹어 글자 묻힘(과거 버그). 정의된 토큰만 쓰고 나머지는 명시색. */
      .bb-graph {
        position: relative; height: 33rem; border: 1px solid #d9dde3; border-radius: 4px;
        background: #f7f8fa; overflow: hidden;
        /* Foblex 테마 토큰을 라이트로 재정의(.bb-graph 스코프). 노드/커넥터 크롬은 내 .gnode/.dot가 단독 제어. */
        --ff-flow-background-color: #f7f8fa;
        --ff-canvas-background-color: #f7f8fa;
        --ff-node-background-color: transparent; --ff-node-border-color: transparent; --ff-node-color: var(--os-ink, #161616);
        --ff-node-padding: 0; --ff-node-width: auto; --ff-node-min-height: 0; --ff-node-shadow: none;
        --ff-connector-background-color: transparent; --ff-connector-border-color: transparent;
        --ff-connector-border-width: 0px; --ff-connector-size: 9px;
        --ff-connection-color: #98a2b3; --ff-connection-hover-color: var(--os-accent, #4c6fff);
        --ff-connection-selected-color: var(--os-accent, #4c6fff); --ff-marker-color: #98a2b3;
      }
      f-flow { width: 100%; height: 100%; display: block; }
      /* 노드 규칙은 .bb-graph로 스코프해 Foblex .f-node를 specificity로 이긴다. */
      .bb-graph .gnode {
        position: absolute; display: flex; align-items: center; gap: 0.4rem; text-align: left;
        min-width: 9.5rem; padding: 0.45rem 0.6rem; border-radius: 6px;
        background: #ffffff; border: 1px solid #d9dde3;
        box-shadow: 0 1px 3px rgba(16, 24, 40, 0.12); cursor: grab; user-select: none;
      }
      .bb-graph .gnode .body { display: flex; flex-direction: column; line-height: 1.2; }
      .bb-graph .gnode strong { font-size: 0.7rem; color: var(--os-ink, #161616); }
      .bb-graph .gnode .sub { font-size: 0.58rem; color: var(--os-ink-muted, #525252); }
      .bb-graph .gnode .dot { position: static; width: 9px; height: 9px; border-radius: 50%; background: var(--os-accent, #4c6fff); flex: 0 0 auto; }
      .bb-graph .gnode.k-service { border-left: 3px solid var(--os-accent, #4c6fff); }
      .bb-graph .gnode.k-data { border-left: 3px solid #98a2b3; }
      .bb-graph .gnode.k-data.s-ready { border-left-color: #16a34a; }
      .bb-graph .gnode.k-data.s-ready .dot { background: #16a34a; }
      .bb-graph .gnode.k-data.s-notready { border-left-color: #d97706; }
      .bb-graph .gnode.k-data.s-notready .dot { background: #d97706; }
      .bb-graph .gnode.k-planned { border-style: dashed; opacity: 0.85; }
      .bb-graph .gnode.k-planned .dot { background: #98a2b3; }
      ::ng-deep f-connection.planned .f-connection-path { stroke-dasharray: 6 4; opacity: 0.6; }
      .legend { position: absolute; left: 0.5rem; bottom: 0.4rem; display: flex; gap: 0.7rem; flex-wrap: wrap; font-size: 0.56rem; color: var(--os-ink-muted, #525252); background: rgba(255, 255, 255, 0.82); padding: 0.2rem 0.45rem; border-radius: 4px; }
      .legend .sw { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 2px; margin-right: 0.2rem; vertical-align: middle; border-left: 3px solid #98a2b3; background: #fff; }
      .legend .sw.k-service { border-left-color: var(--os-accent, #4c6fff); }
      .legend .sw.k-data.s-ready { border-left-color: #16a34a; }
      .legend .sw.k-data.s-notready { border-left-color: #d97706; }
      .legend .sw.k-planned { border-style: dashed; }
      .legend .hint { color: #98a2b3; }
    `,
  ],
})
export class BackboneGraph {
  /** key(postgres/rustfs/gitea) → 상태. 부모(admin-backbone)가 라이브 status 주입. */
  @Input() statusByKey: Record<string, { installed: boolean; ready: boolean }> = {};
  readonly side = EFConnectableSide;

  readonly nodes: GNode[] = [
    { id: 'dupa', label: 'dupa-registry-controller', sub: '감사로그 write/query', x: 24, y: 26, kind: 'service' },
    { id: 'cbk', label: 'console-backend', sub: '사용자 설정·에셋', x: 24, y: 150, kind: 'service' },
    { id: 'recon', label: 'reconciler', sub: 'GitOps drift', x: 24, y: 274, kind: 'planned' },
    { id: 'gitea', label: 'Gitea', sub: '설정 SoT(GitOps)', x: 340, y: 200, kind: 'data', statusKey: 'gitea' },
    { id: 'pg', label: 'PostgreSQL', sub: '앱 DB(감사·설정)', x: 660, y: 56, kind: 'data', statusKey: 'postgres' },
    { id: 'rustfs', label: 'RustFS', sub: 'S3 오브젝트', x: 660, y: 290, kind: 'data', statusKey: 'rustfs' },
  ];
  readonly edges: GEdge[] = [
    { from: 'dupa', to: 'pg' },
    { from: 'cbk', to: 'pg' },
    { from: 'cbk', to: 'rustfs' },
    { from: 'dupa', to: 'rustfs', planned: true },
    { from: 'gitea', to: 'pg' },
    { from: 'gitea', to: 'rustfs' },
    { from: 'recon', to: 'gitea', planned: true },
  ];

  private st(n: GNode) { return n.statusKey ? this.statusByKey[n.statusKey] : undefined; }
  isReady(n: GNode): boolean { return !!this.st(n)?.ready; }
  isNotReady(n: GNode): boolean { const s = this.st(n); return !!s && s.installed && !s.ready; }
  statusText(n: GNode): string {
    const s = this.st(n);
    if (!s) return '';
    return s.ready ? ' · Ready' : s.installed ? ' · NotReady' : ' · 미설치';
  }
}
