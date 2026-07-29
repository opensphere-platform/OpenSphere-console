import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ExtensionHostService } from '../core/extension-host.service';
import { PerspectiveService } from '../core/perspective.service';
import { routeForPlugin } from '../core/perspectives';

interface IndexLink {
  path: string;
  title: string;
  sub: string;
}

interface PerspectiveDef {
  num: number;
  name: string;
  korean: string;
  band: string;
  question: string;
  pluginId: string;
}

interface LayerDef {
  num: number;
  name: string;
  short: string;
  scope: string;
  role: string;
  requires: string;
  establishes: string;
  evidence: string;
  objects: string[];
}

/**
 * The horizontal axis is exactly ten Perspectives. Main Shell is not an
 * eleventh Perspective; it is a Platform Control realization object in L3.
 * A Perspective link becomes actionable only when DUPA publishes its page.
 */
const PERSPECTIVES: PerspectiveDef[] = [
  { num: 1, name: 'Base / Substrate', korean: '기반', band: 'Operate', question: '무엇 위에서 실행되는가', pluginId: 'os' },
  { num: 2, name: 'Kubernetes + Ceph', korean: '클러스터', band: 'Operate', question: '클러스터와 데이터 경로는 건강한가', pluginId: 'cluster-manager' },
  { num: 3, name: 'User', korean: '사용자', band: 'Operate', question: '누가 어떤 권한으로 사용하는가', pluginId: 'identity' },
  { num: 4, name: 'Developer', korean: '개발자', band: 'Build', question: '서비스를 어떻게 만들고 전달하는가', pluginId: 'developer' },
  { num: 5, name: 'AI Level', korean: '지능', band: 'Build', question: '모델과 지능을 어떻게 소비하는가', pluginId: 'ai' },
  { num: 6, name: 'API / Information Flow', korean: '정보 흐름', band: 'Build', question: '무엇을 주고받고 어떤 계약을 지키는가', pluginId: 'api' },
  { num: 7, name: 'Workspace', korean: '내부 업무', band: 'Deliver', question: '직원은 어디에서 업무를 수행하는가', pluginId: 'workspace' },
  { num: 8, name: 'Customer', korean: '고객', band: 'Deliver', question: '고객에게 어떤 경험을 제공하는가', pluginId: 'customer' },
  { num: 9, name: 'External Web Service', korean: '대외 서비스', band: 'Deliver', question: '외부 서비스는 어떻게 안전하게 노출되는가', pluginId: 'edge' },
  { num: 10, name: 'Website', korean: '웹사이트', band: 'Deliver', question: '조직의 얼굴을 어떻게 운영하는가', pluginId: 'website' },
];

/**
 * The vertical axis is persistent operational structure, not a temporary
 * installer timeline. Each upper layer consumes a contract and evidence from
 * the layer below it.
 */
const LAYERS: LayerDef[] = [
  {
    num: 6,
    name: 'Domain Service Layer',
    short: 'Domain Service',
    scope: 'Perspective-owned value',
    role: '직원·고객·개발자에게 실제 업무와 제품 경험을 제공한다.',
    requires: 'L5 PFSS의 소비 계약과 admission',
    establishes: '도메인 서비스, 업무 흐름, 사용자 가치',
    evidence: '사용자 여정, SLO, 도메인별 운영 증거',
    objects: ['Developer', 'Workspace', 'Customer Services', 'External Web', 'Website'],
  },
  {
    num: 5,
    name: 'Platform Foundation Layer',
    short: 'Platform Foundation',
    scope: 'Shared service capability',
    role: '모든 Perspective가 공통으로 소비하는 PFSS capability를 제공한다.',
    requires: 'L4 Platform Support Profile Ready',
    establishes: '공유 identity·data·communication·AI·observability·recovery 계약',
    evidence: 'Model·Claim·Binding, 보호된 I/O, consumer contract',
    objects: ['PFSS', 'Identity', 'Data', 'Communication', 'AI Substrate', 'Observability', 'Backup / Restore'],
  },
  {
    num: 4,
    name: 'Platform Support Layer',
    short: 'Platform Support',
    scope: 'Cross-perspective safety',
    role: '상위 서비스를 반복 가능하게 배포하고 관측·복구·통제할 수 있게 한다.',
    requires: 'L3 control authority와 HIS preflight',
    establishes: 'Delivery·Observability·Backup/Restore·Security/Policy 안전망',
    evidence: 'sync·rollback, telemetry, recovery drill, admission red test',
    objects: ['Argo CD', 'Crossplane', 'Shared Observability', 'Recovery Control', 'Security / Policy'],
  },
  {
    num: 3,
    name: 'Platform Control Layer',
    short: 'Platform Control',
    scope: 'Control and operational authority',
    role: '설치·활성화·정책·진단·감사의 단일 관리 권위를 제공한다.',
    requires: 'L2 Console Backbone Ready',
    establishes: '검증된 Registry, lifecycle control, HIS 운영 표면',
    evidence: '서명 검증, 활성화 상태, CLI parity, append-only audit',
    objects: ['Main Shell', 'DUPA / Registry', 'Cluster Manager', 'OAA Core', 'Policy Gate'],
  },
  {
    num: 2,
    name: 'Console Backbone Layer',
    short: 'Console Backbone',
    scope: 'Durable console authority',
    role: 'Console의 신원·상태·선언형 변경·감사 이력을 내구 저장한다.',
    requires: 'L1의 최소 Console bootstrap 기반',
    establishes: '운영자 신원, durable state, declarative change authority',
    evidence: 'login·role 회수, DB append/read, Git commit/revert',
    objects: ['Supabase Data & Identity', 'Gitea State Change Authority', 'Durable Audit', 'Object History'],
  },
  {
    num: 1,
    name: 'Host Infrastructure Layer',
    short: 'Host Infrastructure',
    scope: 'Host-provided substrate',
    role: 'OpenSphere와 모든 서비스가 실행되는 호스트 기반을 제공한다.',
    requires: 'Kubernetes API에 연결 가능한 물리·가상 인프라',
    establishes: 'compute·network·name resolution·ingress·storage 실행 기반',
    evidence: 'API, CNI, DNS, Ingress, CSI, metrics와 snapshot 실측',
    objects: ['Kubernetes API', 'CNI / DNS / Ingress', 'CSI / Storage', 'Host Metrics', 'Volume Snapshot'],
  },
];

@Component({
  selector: 'os-landing',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <main class="architecture-index">
      <section class="architecture-hero" aria-labelledby="architecture-title">
        <div>
          <p class="eyebrow">OpenSphere architecture index</p>
          <h1 id="architecture-title">
            OpenSphere Ten-Perspective and Six-Layer
            <span>Service Realization Architecture</span>
          </h1>
          <p class="hero-lead">
            10개의 수평적 Perspective로 서비스의 의미를 정의하고, 6개의 수직적 Layer로
            그 서비스가 설치·활성화·운영·복구 가능한 실체가 되는 과정을 정의합니다.
          </p>
        </div>
        <div class="model-equation" aria-label="Ten Perspectives by Six Layers">
          <div>
            <strong>10</strong>
            <span>Perspectives</span>
            <small>Horizontal service lenses</small>
          </div>
          <b aria-hidden="true">×</b>
          <div>
            <strong>6</strong>
            <span>Layers</span>
            <small>Vertical realization structure</small>
          </div>
        </div>
      </section>

      <section class="axis-definitions" aria-label="Architecture axes">
        <article>
          <span class="axis-mark axis-mark-horizontal">Horizontal</span>
          <div>
            <h2>10 Perspectives</h2>
            <p>서비스를 어떤 사용자·업무·정보 흐름의 관점에서 읽고 제공하는지를 정의합니다.</p>
          </div>
        </article>
        <article>
          <span class="axis-mark axis-mark-vertical">Vertical</span>
          <div>
            <h2>6 Service Realization Layers</h2>
            <p>무엇이 먼저 성립해야 하며, 누가 권위를 갖고 어떤 증거로 다음 Layer를 여는지 정의합니다.</p>
          </div>
        </article>
        <article class="coordinate-rule">
          <span class="axis-mark">Coordinate</span>
          <div>
            <h2>Service = Perspective × Layer</h2>
            <p>제품 이름이 아니라 서비스의 의미와 운영 책임이 만나는 좌표에 객체를 배치합니다.</p>
          </div>
        </article>
      </section>

      <section class="model-section" aria-labelledby="model-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">10P × 6L model</p>
            <h2 id="model-title">OpenSphere Service Realization Map</h2>
          </div>
          <p>아래에서 위로 기반이 축적됩니다. 각 Layer의 가로 폭은 10개 Perspective 전체를 지원한다는 뜻입니다.</p>
        </div>

        <div class="model-scroll" tabindex="0" aria-label="10 Perspectives and 6 Layers architecture map">
          <table class="realization-map">
            <thead>
              <tr>
                <th class="axis-corner" scope="col">
                  <span>Service meaning</span>
                  <strong>Perspectives →</strong>
                  <small>Realization ↑</small>
                </th>
                @for (p of perspectiveCards(); track p.num) {
                  <th class="perspective-column" scope="col">
                    @if (p.live) {
                      <a [routerLink]="p.path" [attr.aria-label]="'Perspective ' + p.num + ' ' + p.name">
                        <span>P{{ perspectiveNumber(p.num) }}</span>
                        <strong>{{ p.name }}</strong>
                        <small>{{ p.korean }} · {{ p.band }}</small>
                        <em>등록됨</em>
                      </a>
                    } @else {
                      <div [attr.aria-label]="'Perspective ' + p.num + ' ' + p.name">
                        <span>P{{ perspectiveNumber(p.num) }}</span>
                        <strong>{{ p.name }}</strong>
                        <small>{{ p.korean }} · {{ p.band }}</small>
                        <em>모델 정의</em>
                      </div>
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (layer of layers; track layer.num) {
                <tr>
                  <th class="layer-heading" scope="row">
                    <span>L{{ layer.num }}</span>
                    <strong>{{ layer.short }}</strong>
                    <small>{{ layer.scope }}</small>
                  </th>
                  <td class="layer-track" [class]="'layer-track layer-' + layer.num" colspan="10">
                    <div class="layer-overview">
                      <div>
                        <span class="layer-kicker">L{{ layer.num }} · {{ layer.scope }}</span>
                        <h3>{{ layer.name }}</h3>
                        <p>{{ layer.role }}</p>
                      </div>
                      <div class="object-list" aria-label="Representative objects">
                        @for (object of layer.objects; track object) {
                          <span>{{ object }}</span>
                        }
                      </div>
                    </div>
                    <dl class="layer-contract">
                      <div>
                        <dt>Requires</dt>
                        <dd>{{ layer.requires }}</dd>
                      </div>
                      <div>
                        <dt>Establishes</dt>
                        <dd>{{ layer.establishes }}</dd>
                      </div>
                      <div>
                        <dt>Ready evidence</dt>
                        <dd>{{ layer.evidence }}</dd>
                      </div>
                    </dl>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="model-rules" aria-labelledby="rules-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Reading rules</p>
            <h2 id="rules-title">이 모델을 읽는 세 가지 원칙</h2>
          </div>
        </div>
        <div>
          <article>
            <span>01</span>
            <h3>Layer는 설치 단계가 아닙니다</h3>
            <p>설립 후에도 계속 존재하며 상위 서비스의 운영·업그레이드·삭제·재설치를 지지합니다.</p>
          </article>
          <article>
            <span>02</span>
            <h3>존재는 Ready의 증거가 아닙니다</h3>
            <p>Pod나 객체의 존재가 아니라 실제 I/O, sync, rollback, restore와 정책 실증으로 판정합니다.</p>
          </article>
          <article>
            <span>03</span>
            <h3>한 객체의 권위는 하나입니다</h3>
            <p>여러 Perspective에 노출될 수 있지만 설치·운영 lifecycle을 소유하는 주 Layer는 하나입니다.</p>
          </article>
        </div>
      </section>

      <section class="service-index" aria-labelledby="service-index-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Current implementation</p>
            <h2 id="service-index-title">Operational Service Index</h2>
          </div>
          <p>구조 모델과 현재 실행 가능한 Console 진입점을 분리해 표시합니다.</p>
        </div>
        <div class="service-index-grid">
          <article>
            <div class="service-group-heading">
              <div>
                <span>Native</span>
                <h3>Console control surfaces</h3>
              </div>
              <strong>{{ coreCards().length }}</strong>
            </div>
            <div class="service-links">
              @for (item of coreCards(); track item.path) {
                <a [routerLink]="item.path">
                  <span>{{ item.title }}</span>
                  <small>{{ item.sub }}</small>
                </a>
              }
            </div>
          </article>
          <article>
            <div class="service-group-heading">
              <div>
                <span>DUPA Registry</span>
                <h3>Registered service surfaces</h3>
              </div>
              <strong>{{ extCards().length }}</strong>
            </div>
            @if (extCards().length) {
              <div class="service-links">
                @for (item of extCards(); track item.path) {
                  <a [routerLink]="item.path">
                    <span>{{ item.title }}</span>
                    <small>{{ item.sub }}</small>
                  </a>
                }
              </div>
            } @else {
              <p class="empty-state">검증·활성화되어 Registry에 게시된 서비스가 없습니다.</p>
            }
          </article>
        </div>
      </section>
    </main>
  `,
  styles: [
    `
      :host { display: block; }
      .architecture-index {
        margin: -1.5rem;
        min-height: calc(100% + 3rem);
        padding: 1.5rem 2rem 3rem;
        background: var(--os-overview-bg);
        color: var(--os-ink);
      }
      .architecture-hero,
      .axis-definitions,
      .model-section,
      .model-rules,
      .service-index {
        width: 100%;
      }
      .architecture-hero {
        display: grid;
        grid-template-columns: minmax(0, 1.55fr) minmax(20rem, 0.75fr);
        gap: 2.5rem;
        align-items: end;
        padding: 1.25rem 0 1.75rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .eyebrow {
        margin: 0 0 0.55rem;
        color: var(--os-accent);
        font-size: 0.63rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .architecture-hero h1 {
        max-width: 64rem;
        margin: 0;
        font-size: clamp(1.75rem, 2.8vw, 2.5rem);
        font-weight: 300;
        letter-spacing: -0.035em;
        line-height: 1.06;
      }
      .architecture-hero h1 span {
        display: block;
        margin-top: 0.15rem;
        color: var(--os-ink-muted);
        font-weight: 200;
      }
      .hero-lead {
        max-width: 55rem;
        margin: 1rem 0 0;
        color: var(--os-ink-muted);
        font-size: 0.9rem;
        line-height: 1.65;
      }
      .model-equation {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        min-height: 8rem;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .model-equation > div { display: grid; gap: 0.15rem; padding: 1rem 1.15rem; }
      .model-equation strong { color: var(--os-accent); font-size: 2.25rem; font-weight: 300; line-height: 1; }
      .model-equation span { font-size: 0.76rem; font-weight: 650; }
      .model-equation small { color: var(--os-ink-muted); font-size: 0.56rem; }
      .model-equation b { color: var(--os-ink-muted); font-size: 1.4rem; font-weight: 300; }

      .axis-definitions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        border-top: 0;
        background: var(--os-canvas);
      }
      .axis-definitions article {
        display: grid;
        grid-template-columns: 5.5rem minmax(0, 1fr);
        gap: 0.75rem;
        min-height: 7.25rem;
        padding: 1rem;
        border-right: 1px solid var(--os-hairline);
      }
      .axis-definitions article:last-child { border-right: 0; }
      .axis-mark {
        align-self: start;
        padding-top: 0.25rem;
        border-top: 3px solid var(--os-ink);
        color: var(--os-ink-muted);
        font-size: 0.58rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .axis-mark-horizontal { border-color: var(--os-accent); }
      .axis-mark-vertical { border-color: #8a3ffc; }
      .axis-definitions h2 { margin: 0; font-size: 0.82rem; font-weight: 650; }
      .axis-definitions p { margin: 0.45rem 0 0; color: var(--os-ink-muted); font-size: 0.66rem; line-height: 1.55; }
      .coordinate-rule { background: var(--os-surface-1); }

      .model-section,
      .model-rules,
      .service-index { margin-top: 2rem; }
      .section-heading {
        display: flex;
        justify-content: space-between;
        gap: 2rem;
        align-items: end;
        margin-bottom: 0.65rem;
      }
      .section-heading h2 { margin: 0; font-size: 1.15rem; font-weight: 500; }
      .section-heading > p { max-width: 38rem; margin: 0; color: var(--os-ink-muted); font-size: 0.66rem; line-height: 1.5; text-align: right; }

      .model-scroll {
        overflow-x: auto;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .model-scroll:focus-visible { outline: 2px solid var(--os-accent); outline-offset: 2px; }
      .realization-map {
        width: 100%;
        min-width: 86rem;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .realization-map th,
      .realization-map td { border-right: 1px solid var(--os-hairline); border-bottom: 1px solid var(--os-hairline); }
      .realization-map tr:last-child > * { border-bottom: 0; }
      .realization-map tr > *:last-child { border-right: 0; }
      .axis-corner,
      .layer-heading { width: 13rem; }
      .axis-corner {
        padding: 0.65rem 0.75rem;
        background: #161616;
        color: #fff;
        text-align: left;
        vertical-align: bottom;
      }
      .axis-corner span,
      .axis-corner small { display: block; color: #c6c6c6; font-size: 0.55rem; font-weight: 400; }
      .axis-corner strong { display: block; margin: 0.25rem 0; font-size: 0.72rem; }
      .perspective-column { width: 7.3rem; padding: 0; background: var(--os-surface-1); vertical-align: top; }
      .perspective-column a,
      .perspective-column div {
        display: grid;
        align-content: start;
        min-height: 7.75rem;
        padding: 0.65rem 0.55rem;
        color: inherit;
        text-align: left;
        text-decoration: none;
      }
      .perspective-column a { box-shadow: inset 0 3px 0 var(--os-accent); }
      .perspective-column a:hover { background: var(--os-accent-subtle); }
      .perspective-column span { color: var(--os-accent); font-family: var(--os-font-mono); font-size: 0.57rem; }
      .perspective-column strong { margin-top: 0.45rem; font-size: 0.64rem; line-height: 1.25; }
      .perspective-column small { margin-top: 0.2rem; color: var(--os-ink-muted); font-size: 0.52rem; line-height: 1.35; }
      .perspective-column em { align-self: end; margin-top: auto; padding-top: 0.55rem; color: var(--os-ink-muted); font-size: 0.5rem; font-style: normal; }
      .perspective-column a em { color: var(--os-success); font-weight: 650; }

      .layer-heading {
        padding: 0.8rem 0.75rem;
        background: var(--os-surface-1);
        text-align: left;
        vertical-align: top;
      }
      .layer-heading > span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 1.35rem;
        background: #161616;
        color: #fff;
        font-family: var(--os-font-mono);
        font-size: 0.58rem;
      }
      .layer-heading strong { display: block; margin-top: 0.55rem; font-size: 0.72rem; }
      .layer-heading small { display: block; margin-top: 0.15rem; color: var(--os-ink-muted); font-size: 0.53rem; line-height: 1.35; }
      .layer-track {
        padding: 0;
        background-color: var(--os-canvas);
        background-image: linear-gradient(to right, transparent calc(10% - 1px), rgba(0, 0, 0, 0.055) calc(10% - 1px), rgba(0, 0, 0, 0.055) 10%);
        background-size: 10% 100%;
        vertical-align: top;
      }
      .layer-6 { box-shadow: inset 4px 0 0 #8a3ffc; }
      .layer-5 { box-shadow: inset 4px 0 0 #0f62fe; }
      .layer-4 { box-shadow: inset 4px 0 0 #007d79; }
      .layer-3 { box-shadow: inset 4px 0 0 #525252; }
      .layer-2 { box-shadow: inset 4px 0 0 #6f6f6f; }
      .layer-1 { box-shadow: inset 4px 0 0 #8d8d8d; }
      .layer-overview {
        display: grid;
        grid-template-columns: minmax(17rem, 1.1fr) minmax(22rem, 1.7fr);
        gap: 1rem;
        padding: 0.75rem 0.85rem 0.6rem;
        background: rgba(255, 255, 255, 0.93);
      }
      .layer-kicker { color: var(--os-ink-muted); font-size: 0.52rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
      .layer-overview h3 { margin: 0.2rem 0 0; font-size: 0.78rem; font-weight: 650; }
      .layer-overview p { margin: 0.3rem 0 0; color: var(--os-ink-muted); font-size: 0.61rem; line-height: 1.45; }
      .object-list { display: flex; flex-wrap: wrap; align-content: start; gap: 0.3rem; }
      .object-list span {
        padding: 0.22rem 0.4rem;
        border: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
        color: var(--os-ink-muted);
        font-size: 0.54rem;
      }
      .layer-contract {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin: 0;
        border-top: 1px solid var(--os-hairline);
        background: rgba(255, 255, 255, 0.93);
      }
      .layer-contract div { min-width: 0; padding: 0.55rem 0.7rem; border-right: 1px solid var(--os-hairline); }
      .layer-contract div:last-child { border-right: 0; }
      .layer-contract dt { color: var(--os-ink-muted); font-size: 0.5rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
      .layer-contract dd { margin: 0.18rem 0 0; color: var(--os-ink); font-size: 0.55rem; line-height: 1.4; }

      .model-rules > div,
      .service-index-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .model-rules article { min-height: 8rem; padding: 0.85rem; border-right: 1px solid var(--os-hairline); }
      .model-rules article:last-child { border-right: 0; }
      .model-rules article > span { color: var(--os-accent); font-family: var(--os-font-mono); font-size: 0.58rem; }
      .model-rules h3 { margin: 0.75rem 0 0; font-size: 0.72rem; }
      .model-rules p { margin: 0.35rem 0 0; color: var(--os-ink-muted); font-size: 0.61rem; line-height: 1.5; }

      .service-index-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .service-index-grid > article:first-child { border-right: 1px solid var(--os-hairline); }
      .service-group-heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        min-height: 3.6rem;
        padding: 0.65rem 0.8rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
      }
      .service-group-heading span { color: var(--os-ink-muted); font-size: 0.5rem; text-transform: uppercase; }
      .service-index-grid h3 { margin: 0.12rem 0 0; font-size: 0.72rem; }
      .service-group-heading > strong { color: var(--os-accent); font-size: 1.35rem; font-weight: 300; }
      .service-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .service-links a {
        display: grid;
        min-height: 3.6rem;
        padding: 0.6rem 0.75rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
        color: inherit;
        text-decoration: none;
      }
      .service-links a:nth-child(2n) { border-right: 0; }
      .service-links a:hover { box-shadow: inset 3px 0 0 var(--os-accent); background: var(--os-accent-subtle); }
      .service-links span { font-size: 0.65rem; font-weight: 650; }
      .service-links small { margin-top: 0.15rem; color: var(--os-ink-muted); font-size: 0.53rem; }
      .empty-state { margin: 0; padding: 1rem; color: var(--os-ink-muted); font-size: 0.62rem; }

      @media screen and (max-width: 76rem) {
        .architecture-hero { grid-template-columns: 1fr; }
        .model-equation { max-width: 38rem; }
        .axis-definitions { grid-template-columns: 1fr; }
        .axis-definitions article { border-right: 0; border-bottom: 1px solid var(--os-hairline); }
        .axis-definitions article:last-child { border-bottom: 0; }
      }
      @media screen and (max-width: 56rem) {
        .architecture-index { padding-inline: 1.5rem; }
        .section-heading { display: block; }
        .section-heading > p { margin-top: 0.35rem; text-align: left; }
        .model-rules > div,
        .service-index-grid { grid-template-columns: 1fr; }
        .model-rules article,
        .service-index-grid > article:first-child { border-right: 0; border-bottom: 1px solid var(--os-hairline); }
        .service-index-grid > article:last-child { border-bottom: 0; }
      }
      @media screen and (max-width: 36rem) {
        .architecture-index { margin: -1rem; padding: 1rem 1rem 2rem; }
        .architecture-hero h1 { font-size: 1.8rem; }
        .model-equation { grid-template-columns: 1fr; }
        .model-equation b { display: none; }
        .model-equation > div + div { border-top: 1px solid var(--os-hairline); }
        .axis-definitions article { grid-template-columns: 1fr; }
        .service-links { grid-template-columns: 1fr; }
        .service-links a { border-right: 0; }
      }
    `,
  ],
})
export class Landing {
  private ext = inject(ExtensionHostService);
  private psp = inject(PerspectiveService);

  readonly layers = LAYERS;

  readonly coreCards = computed<IndexLink[]>(() => {
    const base: IndexLink[] = [
      { path: '/manage/catalog', title: 'Developer Catalog', sub: 'Service assets and extensions' },
      { path: '/manage/apis', title: 'APIs', sub: 'Information flow and contracts' },
      { path: '/manual', title: 'Manual', sub: 'Architecture and operations' },
      { path: '/me', title: '내 정보', sub: 'Identity and session' },
    ];
    if (this.psp.isAdmin()) {
      base.push(
        { path: '/manage/data-identity', title: 'Console Backbone', sub: 'Supabase and Gitea authority' },
        { path: '/manage/platform-control', title: 'Platform Control', sub: 'Readiness and evidence' },
        { path: '/manage/extensions', title: 'Extensions', sub: 'DUPA lifecycle and Registry' },
        { path: '/manage/roles', title: '역할', sub: 'Roles and assignments' },
      );
    }
    return base;
  });

  readonly extCards = computed<IndexLink[]>(() =>
    this.ext.pages().map((page) => ({
      path: routeForPlugin(page.id),
      title: page.title,
      sub: `${page.navBand} · ${page.id}`,
    })),
  );

  readonly perspectiveCards = computed(() => {
    const registered = new Set(this.ext.pages().map((page) => page.id));
    return PERSPECTIVES.map((perspective) => ({
      ...perspective,
      live: registered.has(perspective.pluginId),
      path: routeForPlugin(perspective.pluginId),
    }));
  });

  perspectiveNumber(num: number): string {
    return String(num).padStart(2, '0');
  }
}
