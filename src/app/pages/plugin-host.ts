import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
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
 */
@Component({
  selector: 'os-plugin-host',
  imports: [ClarityModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (page(); as p) {
      <div #host></div>
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
        width: calc(100% + 1.5rem);
      }
    `,
  ],
})
export class PluginHost {
  private ext = inject(ExtensionHostService);
  private route = inject(ActivatedRoute);

  // 클린 라우트(`/user`)는 data.pluginId로 슬러그를 넘기고, 폴백 `/p/:id`는 라우트 파라미터로 받는다.
  readonly id = toSignal(
    combineLatest([this.route.data, this.route.paramMap]).pipe(
      map(([data, m]) => (data['pluginId'] as string | undefined) ?? m.get('id') ?? ''),
    ),
    { initialValue: '' },
  );
  readonly page = computed(() => this.ext.pages().find((p) => p.id === this.id()) ?? null);
  readonly failure = computed(() => this.ext.failures().find((f) => f.id === this.id()) ?? null);

  private host = viewChild<ElementRef<HTMLElement>>('host');

  constructor() {
    effect(() => {
      const h = this.host();
      const p = this.page();
      if (h && p) h.nativeElement.replaceChildren(document.createElement(p.elementTag));
    });
  }
}
