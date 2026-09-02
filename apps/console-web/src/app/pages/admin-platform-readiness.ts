import { ChangeDetectionStrategy, Component, Input, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { PlatformReadinessService, PlatformReadinessStatus } from '../core/platform-readiness.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';

@Component({
  selector: 'os-admin-platform-readiness',
  imports: [RouterLink, ClarityModule, OsPageHeader, BackendUnavailable],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (!embedded) {
      <os-page-header title="Console Backbone 준비 상태" tag="Supabase + Gitea + Release Lock + Beszel">
        <p>각 시스템의 현재 권위를 읽기 전용으로 확인합니다. 이 화면은 CRD를 만들거나 상태를 Ready로 기록하지 않습니다.</p>
      </os-page-header>
    }

    @if (error() && !state()) {
      <os-backend-unavailable
        feature="Console Backbone 준비 상태"
        backend="Console API target status families"
        hint="Supabase, Gitea, Release Lock, Beszel endpoint와 현재 세션 권한을 확인하세요."
        [detail]="error()"
      />
    } @else if (state(); as status) {
      <section class="summary" [class.ready]="status.ready" aria-label="Console Backbone 요약">
        <div>
          <span class="eyebrow">READ-ONLY READINESS</span>
          <h2>{{ status.ready ? 'Console Backbone Ready' : '확인이 필요한 Backbone 항목이 있습니다' }}</h2>
          <p>{{ status.ready ? '네 권위의 현재 증거가 모두 Ready입니다.' : nextBlocker(status) }}</p>
        </div>
        <div class="summary-meta">
          <span class="label" [class.label-success]="status.ready" [class.label-warning]="!status.ready">{{ status.phase }}</span>
          <span>{{ displayTime(status.observedAt) }}</span>
          <button class="btn btn-sm" type="button" [disabled]="busy()" (click)="refresh()">새로고침</button>
        </div>
      </section>

      <section class="component-grid" aria-label="필수 Backbone 권위">
        @for (component of status.components; track component.id) {
          <article class="card" [class.ready]="component.ready">
            <div class="card-header">
              <span>{{ component.authority }}</span>
              <strong>{{ component.label }}</strong>
            </div>
            <div class="card-block">
              <span class="label" [class.label-success]="component.ready" [class.label-danger]="!component.ready">{{ component.state }}</span>
              <p>{{ component.detail }}</p>
              <dl>
                <div><dt>Endpoint</dt><dd><code>{{ component.endpoint }}</code></dd></div>
                <div><dt>Observed</dt><dd>{{ displayTime(component.observedAt) }}</dd></div>
              </dl>
              <a class="btn btn-sm btn-link" [routerLink]="component.route">권위 화면 열기</a>
            </div>
          </article>
        }
      </section>

      <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="false">
        <clr-alert-item>
          <span class="alert-text">설치와 복구는 Setup CLI 및 각 소유 기능에서 수행합니다. 이 준비 화면은 네 응답을 결합해 표시할 뿐 상태를 변경하지 않습니다.</span>
        </clr-alert-item>
      </clr-alert>
    } @else {
      <div class="progress loop"><progress></progress></div>
    }
  `,
  styles: [`
    :host { display: block; max-width: 88rem; }
    .summary { display: flex; justify-content: space-between; gap: 1.5rem; padding: 1.15rem 1.25rem; border: 1px solid var(--os-hairline); border-top: 3px solid var(--os-warning); background: #fff; }
    .summary.ready { border-top-color: var(--os-success); }
    .summary h2 { margin: .25rem 0; font-size: 1.15rem; }
    .summary p { margin: 0; color: var(--os-ink-muted); font-size: .78rem; }
    .eyebrow { color: var(--os-accent); font-size: .62rem; font-weight: 700; letter-spacing: .09em; }
    .summary-meta { display: flex; flex-direction: column; align-items: flex-end; gap: .35rem; color: var(--os-ink-muted); font-size: .68rem; }
    .component-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
    .card { margin: 0; border-top: 3px solid var(--os-error); }
    .card.ready { border-top-color: var(--os-success); }
    .card-header span, .card-header strong { display: block; }
    .card-header span { color: var(--os-ink-muted); font-size: .65rem; text-transform: uppercase; letter-spacing: .06em; }
    .card-header strong { margin-top: .15rem; font-size: .95rem; }
    .card-block p { min-height: 2.5rem; color: var(--os-ink-muted); font-size: .75rem; }
    dl { margin: .75rem 0; font-size: .68rem; }
    dl div { display: grid; grid-template-columns: 5rem 1fr; gap: .5rem; padding: .25rem 0; }
    dt { color: var(--os-ink-muted); }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    code { font-size: .64rem; }
    @media (max-width: 64rem) { .component-grid { grid-template-columns: 1fr; } .summary { flex-direction: column; } .summary-meta { align-items: flex-start; } }
  `],
})
export class AdminPlatformReadiness implements OnInit {
  @Input() embedded = false;
  private readonly api = inject(PlatformReadinessService);
  readonly state = signal<PlatformReadinessStatus | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  ngOnInit(): void { void this.refresh(); }

  async refresh(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      this.state.set(await this.api.status());
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }

  nextBlocker(status: PlatformReadinessStatus): string {
    const blocker = status.components.find((component) => !component.ready);
    return blocker ? `${blocker.label}: ${blocker.detail}` : '현재 권위 응답을 다시 확인하세요.';
  }

  displayTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value || '—' : date.toLocaleString('ko-KR');
  }
}