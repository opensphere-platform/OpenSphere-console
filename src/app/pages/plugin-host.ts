import {
  Component,
  ElementRef,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { combineLatest, map } from 'rxjs';
import { ExtensionHostService } from '../core/extension-host.service';
import { CatalogItem, PluginControlClient, Registration } from '../core/plugin-control-client.service';

/**
 * 플러그인 호스트 페이지 — §10 라우팅 계약의 셸측 수신부.
 * /p/:id 로 들어오면 Extension Host에 등록된 커스텀 엘리먼트를 생성해 부착한다.
 * 미등록/로드 실패 시 이 페이지만 경고를 띄운다(§16) — 셸·다른 화면은 무사.
 *
 * 감사 P2-1(런타임 error boundary): 로드 실패 폴백뿐 아니라 **mount 이후 런타임 에러**도 가둔다.
 *  ① mount(createElement/replaceChildren)를 try/catch — 동기 생성 오류를 이 pane으로 격리.
 *  ② 플러그인 코드는 검증된 Blob URL로 import되므로(extension-host), 활성 중 발생한 window error/
 *     unhandledrejection 중 'blob:' 출처만 이 플러그인 탓으로 귀속 → 셸 화이트스크린 대신 복구 배너.
 *  (진짜 격리는 iframe/worker 샌드박스가 필요 — 신뢰 플러그인의 런타임 버그가 셸 UX로 번지는 것을 막는 수준.)
 */
@Component({
  selector: 'os-plugin-host',
  imports: [ClarityModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (page(); as p) {
      @if (runtimeError()) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              플러그인 '{{ id() }}'에서 오류가 발생해 화면을 멈췄습니다(셸은 정상). {{ runtimeError() }}
            </span>
            <div class="alert-actions">
              <button class="btn btn-sm btn-danger-outline" (click)="reload()">다시 로드</button>
            </div>
          </clr-alert-item>
        </clr-alert>
      }
      <div #host [style.display]="runtimeError() ? 'none' : 'block'"></div>
    } @else if (loading()) {
      <section
        class="plugin-loading-surface"
        role="status"
        [attr.aria-label]="'확장 화면을 준비하는 중'"
      >
        <div class="plugin-loading-heading skeleton-block"></div>
        <div class="plugin-loading-summary skeleton-block"></div>
        <div class="plugin-loading-cards" aria-hidden="true">
          <div class="plugin-loading-card skeleton-block"></div>
          <div class="plugin-loading-card skeleton-block"></div>
          <div class="plugin-loading-card skeleton-block"></div>
        </div>
        <div class="plugin-loading-content skeleton-block" aria-hidden="true"></div>
      </section>
    } @else if (management(); as item) {
      <section class="module-management" aria-labelledby="module-management-title">
        <div class="module-management-heading">
          <div>
            <div class="module-management-eyebrow">MODULE MANAGEMENT</div>
            <h1 id="module-management-title">{{ item.catalog?.displayName || id() }}</h1>
            <p>제품 화면은 현재 비활성 상태입니다. 이 관리 화면은 설치·활성화 여부와 관계없이 유지됩니다.</p>
          </div>
          <a class="btn btn-primary" routerLink="/manage/extensions">Modules & Extensions 관리</a>
        </div>
        <div class="module-state-grid">
          <div><span>Installed</span><strong>{{ item.registration ? 'Yes' : 'No' }}</strong></div>
          <div><span>Activated</span><strong>{{ item.registration?.status?.phase === 'Activated' ? 'Yes' : 'No' }}</strong></div>
          <div><span>Ready</span><strong>{{ moduleReady(item.registration) ? 'Yes' : 'No' }}</strong></div>
        </div>
        <dl>
          <dt>Current artifact</dt><dd>{{ item.registration?.status?.currentDigest || '설치되지 않음' }}</dd>
          <dt>Target artifact</dt><dd>{{ item.catalog?.installedDigest || item.catalog?.requestedChannel || '미지정' }}</dd>
          <dt>Blocker</dt><dd>{{ blocker(item.registration) }}</dd>
          <dt>Owner</dt><dd>{{ item.catalog?.owner || 'catalog owner 미보고' }}</dd>
          <dt>해결 route</dt><dd>{{ item.registration?.status?.admission?.route || '/manage/extensions' }}</dd>
        </dl>
        <button class="btn btn-outline" type="button" (click)="refreshManagement()">재검사</button>
      </section>
    } @else if (managementError()) {
      <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
        <clr-alert-item>
          <span class="alert-text">관리 inventory를 읽지 못했습니다. {{ managementError() }}</span>
          <div class="alert-actions"><button class="btn btn-sm" (click)="refreshManagement()">재검사</button></div>
        </clr-alert-item>
      </clr-alert>
    } @else {
      <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
        <clr-alert-item>
          <span class="alert-text">
            플러그인 '{{ id() }}'이(가) 등록되어 있지 않습니다.
            @if (failure(); as f) {
              (로드 실패: {{ f.error }})
            }
            — Registry & Catalog(/api/v1/registry)와 기능 컨테이너 상태를 확인하세요.
          </span>
        </clr-alert-item>
      </clr-alert>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        margin-top: -1.5rem;
        margin-left: -1.5rem;
        margin-bottom: -1.5rem;
        width: calc(100% + 3rem);
        min-height: calc(100% + 3rem);
      }
      .alert-actions { margin-top: 0.4rem; }
      .module-management { box-sizing: border-box; min-height: calc(100vh - 3.5rem); padding: 1.5rem; background: var(--cds-global-color-construction-50, #fafafa); }
      .module-management-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #d9d9d9; }
      .module-management-heading h1 { margin: .2rem 0; font-size: 1.6rem; }
      .module-management-heading p { margin: 0; color: #565656; }
      .module-management-eyebrow { color: #0f62fe; font-size: .72rem; font-weight: 700; letter-spacing: .08em; }
      .module-state-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin: 1rem 0; }
      .module-state-grid div { padding: 1rem; border: 1px solid #d9d9d9; background: #fff; }
      .module-state-grid span { display: block; color: #6f6f6f; font-size: .75rem; }
      .module-state-grid strong { display: block; margin-top: .3rem; font-size: 1.2rem; }
      .module-management dl { display: grid; grid-template-columns: 10rem minmax(0, 1fr); max-width: 60rem; margin: 0 0 1rem; border-top: 1px solid #d9d9d9; }
      .module-management dt, .module-management dd { margin: 0; padding: .65rem; border-bottom: 1px solid #d9d9d9; overflow-wrap: anywhere; }
      .module-management dt { font-weight: 600; background: #f4f4f4; }
      .plugin-loading-surface {
        box-sizing: border-box;
        min-height: calc(100vh - 3.5rem);
        padding: 1.5rem;
        overflow: hidden;
        background: var(--cds-global-color-construction-50, #fafafa);
      }
      .skeleton-block {
        position: relative;
        overflow: hidden;
        border-radius: 0.125rem;
        background: var(--cds-global-color-construction-200, #e8e8e8);
      }
      .skeleton-block::after {
        position: absolute;
        inset: 0;
        content: '';
        transform: translateX(-100%);
        background: linear-gradient(
          90deg,
          transparent,
          color-mix(in srgb, var(--cds-global-color-construction-50, #fafafa) 75%, transparent),
          transparent
        );
        animation: plugin-loading-sweep 1.2s ease-in-out infinite;
      }
      .plugin-loading-heading {
        width: min(20rem, 45%);
        height: 1.5rem;
        margin-bottom: 0.75rem;
      }
      .plugin-loading-summary {
        width: min(34rem, 72%);
        height: 0.75rem;
        margin-bottom: 1.5rem;
      }
      .plugin-loading-cards {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      .plugin-loading-card { height: 8.5rem; }
      .plugin-loading-content { min-height: 18rem; }
      @keyframes plugin-loading-sweep {
        100% { transform: translateX(100%); }
      }
      @media (max-width: 52rem) {
        .plugin-loading-cards { grid-template-columns: 1fr; }
        .plugin-loading-card { height: 5rem; }
      }
      @media (prefers-reduced-motion: reduce) {
        .skeleton-block::after { animation: none; }
      }
    `,
  ],
})
export class PluginHost {
  private ext = inject(ExtensionHostService);
  private control = inject(PluginControlClient);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

  // 클린 라우트(`/user`)는 data.pluginId로 슬러그를 넘기고, 폴백 `/p/:id`는 라우트 파라미터로 받는다.
  readonly id = toSignal(
    combineLatest([this.route.data, this.route.paramMap]).pipe(
      map(([data, m]) => (data['pluginId'] as string | undefined) ?? m.get('id') ?? ''),
    ),
    { initialValue: '' },
  );
  readonly page = computed(() => this.ext.pages().find((p) => p.id === this.id()) ?? null);
  readonly failure = computed(() => this.ext.failures().find((f) => f.id === this.id()) ?? null);
  readonly loading = computed(() => {
    const pluginState = this.ext.pluginLoadState(this.id());
    return pluginState === 'queued' || pluginState === 'loading'
      || (pluginState === undefined && this.ext.loadState() === 'loading');
  });
  readonly runtimeError = signal<string>('');
  readonly management = signal<{ catalog: CatalogItem | null; registration: Registration | null } | null>(null);
  readonly managementError = signal('');
  private managementKey = '';

  private host = viewChild<ElementRef<HTMLElement>>('host');

  constructor() {
    // 활성 플러그인이 있을 때, blob:(검증된 플러그인 번들) 출처의 미포착 오류를 이 pane에 귀속.
    const onError = (e: ErrorEvent) => {
      if (this.page() && typeof e.filename === 'string' && e.filename.startsWith('blob:')) {
        this.runtimeError.set(String(e.message || 'runtime error'));
      }
    };
    const onRej = (e: PromiseRejectionEvent) => {
      const stack = (e?.reason && (e.reason.stack || e.reason.message)) || '';
      if (this.page() && String(stack).includes('blob:')) {
        this.runtimeError.set(String((e.reason && e.reason.message) || 'unhandled rejection'));
      }
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRej);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRej);
    });

    effect(() => {
      const h = this.host();
      const p = this.page();
      this.id(); // 라우트 변경 시 에러 상태 초기화 트리거
      this.runtimeError.set('');
      if (h && p) {
        this.assertApiBase(p.id);
        try {
          h.nativeElement.replaceChildren(document.createElement(p.elementTag));
        } catch (err) {
          // mount 동기 오류 격리 — 셸은 무사, 이 pane만 복구 배너.
          this.runtimeError.set(String((err as Error)?.message || err));
        }
      }
    });

    effect(() => {
      const id = this.id();
      const readyForFallback = Boolean(id) && !this.page() && !this.loading();
      if (!readyForFallback || this.managementKey === id) return;
      this.managementKey = id;
      void this.loadManagement(id);
    });
  }

  /**
   * 마운트 직전 window.__OSP_NG_API_BASE__를 셸이 아는 진실값으로 재설정.
   * subShell(ui-shell.plugin.js)이 이 전역에 1회만 쓰는 구조라, 다른 플러그인을 거쳐 돌아오면
   * stale base를 읽어 엉뚱한 플러그인으로 API 요청이 새는 문제(크로스 플러그인 오염)가 있었다.
   */
  private assertApiBase(pluginId: string): void {
    const base = this.ext.apiBaseByPlugin()[pluginId];
    if (base) (window as unknown as Record<string, string>)['__OSP_NG_API_BASE__'] = base;
  }

  reload(): void {
    this.runtimeError.set('');
    const h = this.host();
    const p = this.page();
    if (h && p) {
      this.assertApiBase(p.id);
      try {
        h.nativeElement.replaceChildren(document.createElement(p.elementTag));
      } catch (err) {
        this.runtimeError.set(String((err as Error)?.message || err));
      }
    }
  }

  moduleReady(registration: Registration | null): boolean {
    return registration?.status?.workload?.phase === 'Ready'
      && registration.status.verification?.manifest === 'Verified'
      && registration.status.verification?.signature === 'Verified';
  }

  blocker(registration: Registration | null): string {
    if (!registration) return 'NotInstalled';
    return registration.status.admission?.reason || registration.status.reason || '없음';
  }

  refreshManagement(): void {
    this.managementKey = '';
    this.management.set(null);
    this.managementError.set('');
    void this.loadManagement(this.id());
  }

  private async loadManagement(id: string): Promise<void> {
    if (!id) return;
    try {
      const [catalog, registrations] = await Promise.all([
        this.control.catalogSnapshot(),
        this.control.registrationsSnapshot(),
      ]);
      // A child plugin normally renders inside its host subShell
      // (`/pfss/postgres`). If that host cannot be mounted, keep the
      // same deep link useful by resolving the deepest registered module
      // segment before falling back to the host id. This is inventory lookup,
      // not a second routing/source-of-truth model.
      const routeSegments = this.route.snapshot.url.map((segment) => segment.path);
      const childSegments = routeSegments[0] === 'pfss' ? routeSegments.slice(1) : routeSegments.slice(2);
      const candidateIds = [...new Set([...childSegments.reverse(), id].filter(Boolean))];
      const targetId = candidateIds.find((candidate) =>
        catalog.items.some((item) => item.name === candidate)
        || registrations.items.some((item) => item.name === candidate),
      ) || id;
      const catalogItem = catalog.items.find((item) => item.name === targetId) || null;
      const registration = registrations.items.find((item) => item.name === targetId) || null;
      if (catalogItem || registration) {
        this.management.set({ catalog: catalogItem, registration });
        this.managementError.set('');
      }
    } catch (error) {
      this.managementError.set(String(error instanceof Error ? error.message : error));
    }
  }
}
