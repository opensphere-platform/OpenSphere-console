import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { CarbonIcon } from '../os/carbon-icon';
import Home16 from '@carbon/icons/es/home/16';
import Code16 from '@carbon/icons/es/code/16';
import Kubernetes16 from '@carbon/icons/es/kubernetes/16';
import ContainerRegistry16 from '@carbon/icons/es/container-registry/16';
import Document16 from '@carbon/icons/es/document/16';

interface CCChild { label: string; route: string }
interface CCGroup { id: string; icon: any; label: string; children: CCChild[] }

/**
 * ContainersLayout — Containers 섹션 레이아웃(2단 보조 내비 + router-outlet).
 * 2단 메뉴 표준 = OpenSphere AI Hub(/p/ai) 방식: Clarity clr-vertical-nav(흰 배경, 12rem, 왼쪽 blue bar active).
 * 네이티브 라우트라 풀블리드는 .cc-frame margin:-1.5rem 가 담당(plugin-host :host 상쇄는 /p/ 전용). active=routerLinkActive.
 */
@Component({
  selector: 'os-containers-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ClarityModule, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="cc-frame">
      <clr-vertical-nav class="cm-nav" [clrVerticalNavCollapsible]="false" aria-label="Containers 보조 내비">
        <div class="cm-brand"><strong>Containers</strong></div>

        <a clrVerticalNavLink routerLink="overview" routerLinkActive="active">
          <os-cicon clrVerticalNavIcon [icon]="iHome" [size]="16" />Overview
        </a>

        @for (g of groups; track g.id) {
          <clr-vertical-nav-group
            [clrVerticalNavGroupExpanded]="isOpen(g.id)"
            (clrVerticalNavGroupExpandedChange)="setOpen(g.id, $event)"
          >
            <os-cicon clrVerticalNavIcon [icon]="g.icon" [size]="16" />{{ g.label }}
            <clr-vertical-nav-group-children>
              @for (c of g.children; track c.route) {
                <a clrVerticalNavLink [routerLink]="c.route" routerLinkActive="active">{{ c.label }}</a>
              }
            </clr-vertical-nav-group-children>
          </clr-vertical-nav-group>
        }

        <a clrVerticalNavLink routerLink="registry" routerLinkActive="active">
          <os-cicon clrVerticalNavIcon [icon]="iRegistry" [size]="16" />Container Registry
        </a>
        <a clrVerticalNavLink href="#docs" (click)="$event.preventDefault()">
          <os-cicon clrVerticalNavIcon [icon]="iDoc" [size]="16" />Docs
        </a>
      </clr-vertical-nav>

      <div class="cc-content"><router-outlet /></div>
    </div>
  `,
  styles: [
    `
      /* 풀블리드(1단 레일·헤더 밀착): 네이티브 라우트라 페이지가 콘솔 콘텐츠 패딩 상쇄. AI 표준 그리드 12rem|1fr. */
      .cc-frame { display: grid; grid-template-columns: 12rem minmax(0, 1fr); margin: -1.5rem; min-height: calc(100% + 3rem); overflow-x: hidden; }

      /* 2단(.cm-nav) 스타일은 전역 styles.scss에 정의(AI Hub 표준). 여기선 레이아웃만. */

      /* 콘텐츠 — overview 공통 배경 토큰(규약: 모든 /overview 동일 배경) + 패딩 */
      .cc-content {
        min-width: 0; overflow-x: hidden; padding: 1.5rem 2rem; color: var(--os-ink);
        background: var(--os-overview-bg);
      }
    `,
  ],
})
export class ContainersLayout {
  readonly iHome = Home16;
  readonly iRegistry = ContainerRegistry16;
  readonly iDoc = Document16;

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
  setOpen(id: string, val: boolean): void { this.open.update((m) => ({ ...m, [id]: val })); }
}
