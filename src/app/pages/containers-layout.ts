import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { CarbonIcon } from '../os/carbon-icon';
import Home16 from '@carbon/icons/es/home/16';
import Code16 from '@carbon/icons/es/code/16';
import Kubernetes16 from '@carbon/icons/es/kubernetes/16';
import ContainerRegistry16 from '@carbon/icons/es/container-registry/16';
import Document16 from '@carbon/icons/es/document/16';
import Launch16 from '@carbon/icons/es/launch/16';
import ChevronRight16 from '@carbon/icons/es/chevron--right/16';
import ChevronDown16 from '@carbon/icons/es/chevron--down/16';

interface CCChild { label: string; route: string }
interface CCGroup { id: string; icon: any; label: string; children: CCChild[] }

/**
 * ContainersLayout — Containers 섹션 레이아웃 (2단 트리 보조 내비 + router-outlet).
 * 각 항목은 실제 자식 라우트(routerLink) → 페이지 진입 시 routerLinkActive로 2단 active 자동 표시.
 * 그룹(Serverless/Cluster management)은 트리(접기/펼치기). 콘텐츠 배경/패딩은 .cc-content가 제공.
 */
@Component({
  selector: 'os-containers-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="cc-frame">
      <nav class="cc-secondbar" aria-label="Containers 보조 내비">
        <div class="cc-title"><strong>Containers</strong></div>
        <div class="cc-items" role="menu">
          <a class="cc-item" routerLink="overview" routerLinkActive="is-active">
            <os-cicon [icon]="iHome" [size]="16" /><span class="lbl">Overview</span>
          </a>

          @for (g of groups; track g.id) {
            <div class="cc-group" [class.is-open]="isOpen(g.id)">
              <button type="button" class="cc-item cc-group-title" (click)="toggle(g.id)" [attr.aria-expanded]="isOpen(g.id)">
                <os-cicon [icon]="g.icon" [size]="16" /><span class="lbl">{{ g.label }}</span>
                <os-cicon class="cc-chev" [icon]="isOpen(g.id) ? iDown : iRight" [size]="16" />
              </button>
              <div class="cc-nested">
                @for (c of g.children; track c.route) {
                  <a class="cc-child" [routerLink]="c.route" routerLinkActive="is-active">{{ c.label }}</a>
                }
              </div>
            </div>
          }

          <a class="cc-item" routerLink="registry" routerLinkActive="is-active">
            <os-cicon [icon]="iRegistry" [size]="16" /><span class="lbl">Container Registry</span>
          </a>

          <div class="cc-sep"></div>
          <a class="cc-item" href="#docs" (click)="$event.preventDefault()">
            <os-cicon [icon]="iDoc" [size]="16" /><span class="lbl">Docs</span>
            <os-cicon class="cc-ext" [icon]="iLaunch" [size]="16" />
          </a>
        </div>
      </nav>
      <div class="cc-content"><router-outlet /></div>
    </div>
  `,
  styles: [
    `
      /* content-area 패딩 상쇄 + 풀하이트. */
      .cc-frame { display: flex; align-items: stretch; margin: -1.5rem; min-height: calc(100% + 3rem); overflow-x: hidden; }

      /* 2단 보조 내비 (화이트) */
      .cc-secondbar { flex: 0 0 15.75rem; width: 15.75rem; overflow-y: auto; background: #fff; border-inline-end: 1px solid var(--os-hairline); }
      .cc-title { display: flex; align-items: center; min-height: 3.25rem; padding-inline: 1rem; border-block-end: 1px solid var(--os-hairline); }
      .cc-title strong { font-size: 0.875rem; font-weight: 600; color: var(--os-ink); }

      .cc-item {
        display: grid; grid-template-columns: 1rem minmax(0, 1fr) auto; column-gap: 0.5rem; align-items: center;
        width: 100%; min-height: 2.25rem; padding: 0.5rem 1rem; border: 0; background: transparent; text-align: left;
        color: var(--os-ink-muted); font-size: 0.875rem; font-family: inherit; text-decoration: none; cursor: pointer;
        border-left: 3px solid transparent;
      }
      .cc-item os-cicon { color: var(--os-ink-muted); }
      .cc-item:hover { background: var(--os-nav-hover); color: var(--os-ink); }
      a.cc-item.is-active { background: var(--os-nav-hover); color: var(--os-ink); font-weight: 600; border-left-color: var(--os-accent); }
      .cc-chev, .cc-ext { color: var(--os-ink-subtle); }

      .cc-nested { display: none; }
      .cc-group.is-open > .cc-nested { display: block; }
      /* 활성 자식이 있는 그룹은 접혀 있어도 자동으로 펼침 */
      .cc-group:has(.cc-child.is-active) > .cc-nested { display: block; }
      .cc-child {
        display: block; padding: 0.45rem 1rem 0.45rem 2.55rem; color: var(--os-ink-muted);
        font-size: 0.84rem; text-decoration: none; cursor: pointer; border-left: 3px solid transparent;
      }
      .cc-child:hover { background: var(--os-nav-hover); color: var(--os-ink); }
      .cc-child.is-active { background: var(--os-nav-hover); color: var(--os-ink); font-weight: 600; border-left-color: var(--os-accent); }
      .cc-sep { height: 1px; background: var(--os-hairline); margin: 0.5rem 0; }

      /* 콘텐츠 — Containers 공통 배경(그라데이션) + 패딩 */
      .cc-content {
        flex: 1 1 auto; min-width: 0; padding: 1.5rem 2rem; overflow-x: hidden; color: var(--os-ink);
        background:
          radial-gradient(circle at 82% 82%, rgba(190, 230, 255, 0.5), transparent 26rem),
          radial-gradient(circle at 92% 72%, rgba(255, 214, 232, 0.4), transparent 24rem),
          var(--os-surface-1);
      }
    `,
  ],
})
export class ContainersLayout {
  readonly iHome = Home16;
  readonly iRegistry = ContainerRegistry16;
  readonly iDoc = Document16;
  readonly iLaunch = Launch16;
  readonly iRight = ChevronRight16;
  readonly iDown = ChevronDown16;

  readonly groups: CCGroup[] = [
    {
      id: 'serverless', icon: Code16, label: 'Serverless',
      children: [
        { label: 'Get started', route: 'serverless/get-started' },
        { label: 'Serverless projects', route: 'serverless/projects' },
        { label: 'CLI', route: 'serverless/cli' },
      ],
    },
    {
      id: 'clusters', icon: Kubernetes16, label: 'Cluster management',
      children: [
        { label: 'Get started', route: 'cluster-management/get-started' },
        { label: 'Clusters', route: 'cluster-management/clusters' },
        { label: 'Reservations', route: 'cluster-management/reservations' },
        { label: 'Helm catalog', route: 'cluster-management/helm' },
      ],
    },
  ];

  private readonly open = signal<Record<string, boolean>>({ serverless: true, clusters: true });
  isOpen(id: string): boolean { return !!this.open()[id]; }
  toggle(id: string): void { this.open.update((m) => ({ ...m, [id]: !m[id] })); }
}
