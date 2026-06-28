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
import { ClarityModule } from '@clr/angular';
import { combineLatest, map } from 'rxjs';
import { ExtensionHostService } from '../core/extension-host.service';

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
  imports: [ClarityModule],
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
    } @else {
      <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
        <clr-alert-item>
          <span class="alert-text">
            플러그인 '{{ id() }}'이(가) 등록되어 있지 않습니다.
            @if (failure(); as f) {
              (로드 실패: {{ f.error }})
            }
            — 레지스트리(/registry/plugins.json)와 기능 컨테이너 상태를 확인하세요.
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
    `,
  ],
})
export class PluginHost {
  private ext = inject(ExtensionHostService);
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
  readonly runtimeError = signal<string>('');

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
        try {
          h.nativeElement.replaceChildren(document.createElement(p.elementTag));
        } catch (err) {
          // mount 동기 오류 격리 — 셸은 무사, 이 pane만 복구 배너.
          this.runtimeError.set(String((err as Error)?.message || err));
        }
      }
    });
  }

  reload(): void {
    this.runtimeError.set('');
    const h = this.host();
    const p = this.page();
    if (h && p) {
      try {
        h.nativeElement.replaceChildren(document.createElement(p.elementTag));
      } catch (err) {
        this.runtimeError.set(String((err as Error)?.message || err));
      }
    }
  }
}
