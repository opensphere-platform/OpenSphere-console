import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { CarbonIcon } from '../os/carbon-icon';
import Home16 from '@carbon/icons/es/home/16';
import Code16 from '@carbon/icons/es/code/16';
import ContainerRegistry16 from '@carbon/icons/es/container-registry/16';
import Document16 from '@carbon/icons/es/document/16';
import Launch16 from '@carbon/icons/es/launch/16';
import ChevronRight16 from '@carbon/icons/es/chevron--right/16';
import ChevronDown16 from '@carbon/icons/es/chevron--down/16';
import Kubernetes16 from '@carbon/icons/es/kubernetes/16';
import Information20 from '@carbon/icons/es/information/20';
import Code32 from '@carbon/icons/es/code/32';
import Kubernetes32 from '@carbon/icons/es/kubernetes/32';
import ContainerRegistry32 from '@carbon/icons/es/container-registry/32';

/**
 * ACC(OCI-AreaControlCenter) `/containers/overview`의 1:1 이식 (사용자 소유 코드, 복사 승인).
 * 원본: web/src/components/cloud-page/CloudClonePage.tsx(ContainersOverviewPage) + ConsoleShell.tsx(SecondMenu) + styles/carbon.scss.
 * 구조·텍스트·트리·CSS·히어로 SVG 에셋을 원본 그대로 가져왔다(React/Carbon → Angular/표준 마크업, 시각 동일).
 * 히어로 일러스트 = public/ibm-assets/containers-pillar-overview-header.svg (ACC public 에셋 복사).
 */
@Component({
  selector: 'os-containers',
  imports: [CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="cc-frame">
      <!-- ── 2단 보조 내비 (ConsoleShell SecondMenu, Containers) ── -->
      <nav class="ibm-console-secondbar" aria-label="Containers second-level navigation">
        <div class="ibm-console-secondbar__title"><strong>Containers</strong></div>
        <div class="ibm-console-secondbar__items" role="menu">
          <a class="is-active" role="menuitem">
            <os-cicon [icon]="iHome" [size]="16" /><span>Overview</span>
          </a>

          @for (g of groups; track g.id) {
            <div class="ibm-console-secondbar__group" [class.is-open]="isOpen(g.id)">
              <button type="button" class="ibm-console-secondbar__group-title" [attr.aria-expanded]="isOpen(g.id)" (click)="toggle(g.id)">
                <os-cicon [icon]="g.icon" [size]="16" /><span>{{ g.label }}</span>
                <os-cicon [icon]="isOpen(g.id) ? iDown : iRight" [size]="16" />
              </button>
              <div class="ibm-console-secondbar__nested" role="menu">
                @for (c of g.children; track c) {
                  <a role="menuitem"><span>{{ c }}</span></a>
                }
              </div>
            </div>
          }

          <a role="menuitem">
            <os-cicon [icon]="iDoc" [size]="16" /><span>Docs</span><os-cicon [icon]="iLaunch" [size]="16" />
          </a>
        </div>
      </nav>

      <!-- ── 콘텐츠 (ContainersOverviewPage) ── -->
      <div class="ibm-containers-overview-page">
        <section class="ibm-containers-hero">
          <div class="ibm-containers-hero__copy">
            <h1>Run and manage containerized applications</h1>
            <p>From Kubernetes and Red Hat OpenShift, to Serverless solutions, we’ve got you covered.</p>
          </div>
          <div class="ibm-containers-hero__art" aria-hidden="true">
            <img src="/ibm-assets/containers-pillar-overview-header.svg" alt="" />
          </div>
        </section>

        <section class="ibm-containers-promo" aria-label="Containers promotion">
          <os-cicon [icon]="iInfo" [size]="20" />
          <div>
            <strong>50% savings for 6 months with promo code TRYCONTAINERS</strong>
            <p>For a limited time, use this promo code to save on selected IBM Cloud container services.</p>
          </div>
          <a class="cc-link" href="#claim" (click)="$event.preventDefault()">Claim now</a>
        </section>

        <section class="ibm-containers-section">
          <h2>Jump in</h2>
          <div class="ibm-containers-jump-grid">
            <div class="ibm-containers-action-card">
              <os-cicon [icon]="iCode32" [size]="32" />
              <h3>Run code, jobs, or container images</h3>
              <p>Deploy serverless workloads with IBM Cloud Code Engine.</p>
            </div>
            <div class="ibm-containers-action-card">
              <os-cicon [icon]="iKube32" [size]="32" />
              <h3>Create a cluster</h3>
              <p>Build Kubernetes or Red Hat OpenShift clusters for production apps.</p>
            </div>
            <div class="ibm-containers-action-card">
              <os-cicon [icon]="iReg32" [size]="32" />
              <h3>Browse Deployable architectures</h3>
              <p>Start from deployable architectures and reusable templates.</p>
            </div>
          </div>
        </section>

        <section class="ibm-containers-section ibm-containers-dashboard">
          <h2>Dashboard</h2>
          <div class="ibm-containers-dashboard-grid">
            <div class="ibm-containers-inventory-card">
              <div class="ibm-containers-card-heading"><h3>Inventory</h3></div>
              <ul>
                <li><span>Serverless projects</span><a class="cc-link" href="#serverless-projects" (click)="$event.preventDefault()">0</a></li>
                <li><span>Clusters</span><a class="cc-link" href="#clusters" (click)="$event.preventDefault()">0</a></li>
                <li><span>Namespaces</span><a class="cc-link" href="#namespaces" (click)="$event.preventDefault()">0</a></li>
              </ul>
            </div>
            <div class="ibm-containers-side-card">
              <h3>Jump back in</h3>
              <p>Your recently used container resources will appear here.</p>
            </div>
            <div class="ibm-containers-side-card">
              <h3>Explore the docs</h3>
              <p>Find tutorials, CLI references, and container service guides.</p>
              <a class="cc-link cc-link--icon" href="#docs" (click)="$event.preventDefault()">Open docs <os-cicon [icon]="iLaunch" [size]="16" /></a>
            </div>
          </div>
        </section>
      </div>
    </div>
  `,
  styles: [
    `
      /* content-area 패딩(1.1rem 1.4rem) 상쇄 + 1단(셸) 우측에 [2단 | 콘텐츠] 배치 */
      .cc-frame { display: flex; align-items: stretch; margin: -1.5rem; min-height: calc(100% + 3rem); overflow-x: hidden; }

      /* ───────── 2단 보조 내비 (carbon.scss .ibm-console-secondbar 이식) ───────── */
      .ibm-console-secondbar {
        flex: 0 0 15.75rem; width: 15.75rem; overflow-y: auto;
        background: #ffffff; border-inline-end: 1px solid #e0e0e0;
      }
      .ibm-console-secondbar__title {
        display: flex; align-items: center; min-height: 3.25rem;
        padding-inline: 1rem; border-block-end: 1px solid #e0e0e0;
      }
      .ibm-console-secondbar__title strong { font-size: 0.875rem; font-weight: 600; color: #161616; }
      .ibm-console-secondbar__items { padding-block: 0; }

      .ibm-console-secondbar a,
      .ibm-console-secondbar__group-title {
        display: grid; grid-template-columns: 1rem minmax(0, 1fr) auto; column-gap: 0.5rem;
        align-items: center; min-height: 2.25rem; padding: 0.5rem 1rem;
        color: #525252; font-size: 0.875rem; font-family: inherit; text-align: left;
        text-decoration: none; cursor: pointer; background: transparent; border: 0; width: 100%;
      }
      .ibm-console-secondbar a os-cicon, .ibm-console-secondbar__group-title os-cicon { color: #525252; }
      .ibm-console-secondbar a:hover,
      .ibm-console-secondbar__group-title:hover { background: #e8e8e8; color: #161616; }
      .ibm-console-secondbar a.is-active {
        background: #e0e0e0; box-shadow: inset 3px 0 0 #0f62fe; color: #161616; font-weight: 600;
      }

      .ibm-console-secondbar__nested { display: none; }
      .ibm-console-secondbar__group.is-open > .ibm-console-secondbar__nested { display: block; }
      .ibm-console-secondbar__nested a {
        grid-template-columns: minmax(0, 1fr) auto; padding-inline-start: 2.25rem;
      }
      /* 그룹 구분선(원본 :has 규칙): 마지막 그룹(Registry) 아래 = Docs 앞 */
      .ibm-console-secondbar__group:last-of-type { border-block-end: 1px solid #e0e0e0; }

      /* ───────── 콘텐츠 (carbon.scss .ibm-containers-* 이식) ───────── */
      .ibm-containers-overview-page {
        flex: 1 1 auto; min-width: 0; min-height: 100%; padding-block-end: 4rem; color: #161616;
        background:
          radial-gradient(circle at 82% 82%, rgba(190, 230, 255, 0.7), transparent 26rem),
          radial-gradient(circle at 92% 72%, rgba(255, 214, 232, 0.55), transparent 24rem),
          #f4f4f4;
      }

      .ibm-containers-hero {
        display: grid; align-items: center; min-height: 19rem;
        grid-template-columns: minmax(0, 1fr) 22rem; padding: 3.25rem 1.75rem 2.25rem; max-width: 87rem;
      }
      .ibm-containers-hero__copy h1 {
        max-width: 43rem; margin: 0; font-size: clamp(3rem, 4vw, 4rem); font-weight: 300;
        letter-spacing: -0.03em; line-height: 1.05;
      }
      .ibm-containers-hero__copy p {
        max-width: 42rem; margin-block: 1.25rem 0; color: #525252; font-size: 1.125rem; line-height: 1.45;
      }
      .ibm-containers-hero__art { position: relative; height: 14rem; transform: scale(0.82); transform-origin: center right; }
      .ibm-containers-hero__art img { display: block; height: 100%; width: 100%; object-fit: contain; object-position: right center; }

      .ibm-containers-promo {
        display: grid; grid-template-columns: auto 1fr auto; align-items: flex-start; gap: 2rem;
        margin: 0 1.75rem 2.25rem; padding: 0.875rem 1rem; max-width: 87rem;
        background: #edf5ff; border: 1px solid #0f62fe;
      }
      .ibm-containers-promo > os-cicon { color: #0f62fe; margin-block-start: 0.125rem; }
      .ibm-containers-promo strong { display: block; margin-block-end: 0.25rem; font-size: 1rem; font-weight: 400; }
      .ibm-containers-promo p { margin: 0; color: #525252; font-size: 0.875rem; }

      .ibm-containers-section { margin: 0 1.75rem 2.25rem; max-width: 87rem; }
      .ibm-containers-section h2 { margin: 0 0 0.75rem; font-size: 1.5rem; font-weight: 400; }

      .ibm-containers-jump-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.0625rem; }
      .ibm-containers-action-card {
        display: flex; flex-direction: column; min-height: 10.5rem; padding: 1rem; background: #ffffff; box-shadow: none;
      }
      .ibm-containers-action-card os-cicon { color: #525252; order: 3; margin-block-start: auto; }
      .ibm-containers-action-card h3 { margin: 0 0 0.75rem; font-size: 1.125rem; font-weight: 400; line-height: 1.3; }
      .ibm-containers-action-card p { margin: 0; color: #525252; font-size: 0.875rem; line-height: 1.45; }

      .ibm-containers-dashboard-grid {
        display: grid; grid-template-columns: 1.35fr 1fr 1fr; grid-template-rows: auto; gap: 0.0625rem;
      }
      .ibm-containers-inventory-card, .ibm-containers-side-card {
        min-height: 12rem; padding: 1rem; background: #ffffff; box-shadow: none;
      }
      .ibm-containers-card-heading { display: flex; align-items: center; justify-content: space-between; }
      .ibm-containers-card-heading h3, .ibm-containers-side-card h3 { margin: 0 0 1rem; font-size: 1.125rem; font-weight: 400; line-height: 1.3; }
      .ibm-containers-inventory-card ul { padding: 0; margin: 1.5rem 0 0; list-style: none; }
      .ibm-containers-inventory-card li {
        display: grid; grid-template-columns: 1fr auto; align-items: center; min-height: 2.75rem;
        border-block-end: 1px solid #e0e0e0;
      }
      .ibm-containers-inventory-card li span { color: #525252; }
      .ibm-containers-inventory-card li a { font-size: 0.875rem; }
      .ibm-containers-side-card p { margin: 0 0 1rem; color: #525252; font-size: 0.875rem; line-height: 1.45; }

      /* Carbon Link 톤(IBM blue) */
      .cc-link { color: #0f62fe; text-decoration: none; cursor: pointer; }
      .cc-link:hover { text-decoration: underline; }
      .cc-link--icon { display: inline-flex; align-items: center; gap: 0.35rem; }

      @media screen and (max-width: 66rem) {
        .ibm-containers-hero, .ibm-containers-jump-grid, .ibm-containers-dashboard-grid { grid-template-columns: 1fr; }
        .ibm-containers-hero__art { display: none; }
      }
    `,
  ],
})
export class Containers {
  readonly iHome = Home16;
  readonly iDoc = Document16;
  readonly iLaunch = Launch16;
  readonly iRight = ChevronRight16;
  readonly iDown = ChevronDown16;
  readonly iInfo = Information20;
  readonly iCode32 = Code32;
  readonly iKube32 = Kubernetes32;
  readonly iReg32 = ContainerRegistry32;

  /** 2단 트리 — ConsoleShell.tsx Containers children 그대로. */
  readonly groups = [
    { id: 'serverless', icon: Code16, label: 'Serverless', children: ['Get started', 'Serverless projects', 'CLI'] },
    { id: 'clusters', icon: Kubernetes16, label: 'Cluster management', children: ['Get started', 'Clusters', 'Reservations', 'Helm catalog'] },
    { id: 'registry', icon: ContainerRegistry16, label: 'Container Registry', children: ['Container Registry'] },
  ];

  private readonly open = signal<Record<string, boolean>>({ serverless: true, clusters: true, registry: false });
  isOpen(id: string): boolean { return !!this.open()[id]; }
  toggle(id: string): void { this.open.update((m) => ({ ...m, [id]: !m[id] })); }
}
