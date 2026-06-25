import { Component, inject, Input, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { NavNode } from '../core/extension-host.service';

/**
 * os-nav-node — 플러그인이 기여한 재귀 NavNode를 셸 내비에 네이티브로 렌더(임의 깊이).
 * children 있으면 Clarity nav 그룹(접기/펼치기), 없으면 링크(리프).
 *
 * 리프 route = '/p/<id>#<해시>' deep-link. 라우팅 처리:
 *  - 다른 페이지에 있으면: 라우터로 이동(플러그인 마운트) → 마운트 시 해시를 읽는다.
 *  - 같은 페이지에 있으면: location.hash를 직접 바꿔 'hashchange'를 발생시킨다.
 *    (Angular routerLink는 fragment 변경을 pushState로 처리해 hashchange가 안 터지므로,
 *     HashRouter 기반 플러그인(Headlamp)이 2번째 이후 메뉴 클릭에 반응하지 않는 문제 해결.)
 */
@Component({
  selector: 'os-nav-node',
  imports: [ClarityModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (node.children?.length) {
      <clr-vertical-nav-group>
        <a clrVerticalNavLink href="javascript:void(0)">{{ node.label }}</a>
        <clr-vertical-nav-group-children>
          @for (child of node.children; track child.id) {
            <os-nav-node [node]="child" />
          }
        </clr-vertical-nav-group-children>
      </clr-vertical-nav-group>
    } @else {
      <a clrVerticalNavLink [href]="node.route" (click)="go($event)" [class.active]="isActive()">{{
        node.label
      }}</a>
    }
  `,
})
export class OsNavNode {
  @Input({ required: true }) node!: NavNode;
  private router = inject(Router);

  private parts(): [string, string] {
    const [path, hash = ''] = (this.node.route ?? '').split('#');
    return [path, hash];
  }

  isActive(): boolean {
    const [path, hash] = this.parts();
    return window.location.pathname === path && window.location.hash.replace(/^#/, '') === hash;
  }

  go(e: Event): void {
    e.preventDefault();
    const [path, hash] = this.parts();
    if (window.location.pathname === path) {
      // 이미 플러그인 페이지: 해시만 교체 → 네이티브 hashchange 발생 → 플러그인 라우터 반응
      const target = hash ? '#' + hash : '';
      if (window.location.hash !== target) {
        window.location.hash = target;
      } else {
        // 동일 해시 재클릭: 강제로 알린다
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    } else {
      // 다른 페이지: 라우터로 이동(플러그인 마운트). 마운트 시 해시를 읽는다.
      this.router.navigateByUrl(path + (hash ? '#' + hash : ''));
    }
  }
}
