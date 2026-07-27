import { Injectable, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import {
  controlCenterIdFromUrl,
  DEFAULT_CONTROL_CENTER_ID,
  routeForPlugin,
} from './perspectives';

const SESSION_KEY = 'rcc.controlCenterId';

/**
 * Main Shell이 현재 제어센터 문맥을 한곳에서 소유한다.
 *
 * 지역 화면(`/cc/<id>/...`)을 방문하면 그 ID를 기억하고, 홈·검색·확장 메뉴에서도
 * 같은 지역을 유지한다. 저장값과 URL은 모두 perspectives.ts의 닫힌 형식 검사를 거친다.
 */
@Injectable({ providedIn: 'root' })
export class ControlCenterContextService {
  private readonly router = inject(Router);
  readonly id = signal(this.initialId());

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.capture(event.urlAfterRedirects);
    });
  }

  pluginRoute(pluginId: string): string {
    return routeForPlugin(pluginId, this.id());
  }

  private initialId(): string {
    const fromRouter = controlCenterIdFromUrl(this.router.url);
    const fromLocation = controlCenterIdFromUrl(window.location.pathname);
    let fromSession: string | null = null;
    try {
      fromSession = controlCenterIdFromUrl(`/cc/${sessionStorage.getItem(SESSION_KEY) ?? ''}/`);
    } catch {
      // sessionStorage를 사용할 수 없는 브라우저에서도 기본 지역으로 안전하게 시작한다.
    }
    return fromRouter ?? fromLocation ?? fromSession ?? DEFAULT_CONTROL_CENTER_ID;
  }

  private capture(url: string): void {
    const next = controlCenterIdFromUrl(url);
    if (!next || next === this.id()) return;
    this.id.set(next);
    try {
      sessionStorage.setItem(SESSION_KEY, next);
    } catch {
      // 메모리 signal은 이미 갱신됐으므로 저장소 차단이 현재 탐색을 깨지 않는다.
    }
  }
}
