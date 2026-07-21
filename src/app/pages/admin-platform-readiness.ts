import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { OsPageHeader } from '../os/os-page-header';
import { BackendUnavailable } from '../os/backend-unavailable';
import {
  PlatformReadinessService,
  PlatformReadinessStatus,
  ReadinessCondition,
  ReadinessLifecycle,
} from '../core/platform-readiness.service';

/**
 * Console-native lifecycle gate between HIS and PFS (CONSTITUTION-0004 §7~§8).
 * This page aggregates authoritative server evidence and records PlatformSupportProfile
 * preflight/verification. It never installs HIS itself; Cluster Manager owns those mutations.
 */
@Component({
  selector: 'os-admin-platform-readiness',
  imports: [FormsModule, RouterLink, ClarityModule, OsPageHeader, BackendUnavailable],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <os-page-header title="플랫폼 준비 상태" tag="Platform Support Profile · Console native">
      <p>CBS와 Main Shell, Cluster Manager, HIS의 실제 상태를 검증하고 PFS 설치 허용 여부를 결정합니다.</p>
    </os-page-header>

    @if (error() && !state()) {
      <os-backend-unavailable
        feature="플랫폼 준비 상태"
        backend="opensphere-console-dupa-controller (/api/admin/platform-readiness)"
        hint="PlatformSupportProfile CRD와 DUPA RBAC·배포 상태를 확인하세요."
        [detail]="error()"
      />
    } @else if (state(); as s) {
      @if (error()) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item></clr-alert>
      }
      @if (notice()) {
        <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="true" (clrAlertClosedChange)="notice.set('')"><clr-alert-item><span class="alert-text">{{ notice() }}</span></clr-alert-item></clr-alert>
      }
      @if (s.admission.foundationActivationOverride) {
        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text"><strong>개발 예외 활성:</strong> Foundation subShell 활성화만 허용됩니다. Platform Support Profile은 여전히 {{ s.phase }}이며 PFS plugin 설치는 차단됩니다.</span></clr-alert-item></clr-alert>
      }

      <section class="pr-summary" aria-label="플랫폼 준비 상태 요약">
        <div>
          <span class="label" [class.label-success]="s.ready" [class.label-danger]="!s.ready">{{ s.phase }}</span>
          <h2>{{ s.ready ? 'PFS 정식 구성 가능' : 'Platform Support Profile 미충족' }}</h2>
          <p>{{ s.ready ? '필수 증거가 모두 확인되어 Foundation과 PFS plugin 구성이 허용됩니다.' : nextBlocker(s) }}</p>
        </div>
        <div class="pr-summary-meta">
          <span>관측 {{ displayTime(s.observedAt) }}</span>
          <span>최근 검증 {{ displayTime(s.profile.lastVerifiedAt) }}</span>
          <button class="btn btn-sm" type="button" [disabled]="busy()" (click)="refresh()">새로고침</button>
        </div>
      </section>

      <section class="pr-lifecycle" aria-labelledby="lifecycle-title">
        <div class="pr-section-heading">
          <div><span class="pr-eyebrow">LIFECYCLE</span><h2 id="lifecycle-title">플랫폼 구성 단계</h2></div>
          <span class="pr-sub">준비되지 않은 첫 단계에서 다음 단계가 잠깁니다.</span>
        </div>
        <ol>
          @for (step of s.lifecycle; track step.key; let i = $index) {
            <li [class.ready]="step.ready" [class.available]="step.state === 'Available'" [class.blocked]="step.state === 'Blocked' || step.state === 'Locked'">
              <span class="pr-step-no">{{ i + 1 }}</span>
              <div><strong>{{ step.label }}</strong><span>{{ step.detail }}</span></div>
              <span class="label" [class.label-success]="step.ready" [class.label-warning]="step.state === 'Available'">{{ step.state }}</span>
            </li>
          }
        </ol>
      </section>

      <div class="pr-grid">
        <section class="card" aria-labelledby="prerequisite-title">
          <div class="card-header" id="prerequisite-title">선행 조건</div>
          <div class="card-block">
            @for (item of s.prerequisites; track item.key) {
              <div class="pr-check-row">
                <span class="pr-dot" [class.ok]="item.ready"></span>
                <div><strong>{{ item.label }}</strong><span>{{ item.detail }}</span></div>
                @if (!item.ready) { <a class="btn btn-sm btn-link" [routerLink]="item.route">조치</a> }
              </div>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="profile-title">
          <div class="card-header" id="profile-title">Platform Support Profile</div>
          <div class="card-block">
            <div class="pr-profile-meta">
              <span>선언</span><strong>{{ s.profile.declared ? '구성됨' : '미구성' }}</strong>
              <span>CRD</span><strong>{{ s.profile.crdReady ? 'Ready' : 'Unavailable' }}</strong>
              <span>세대</span><strong>{{ s.profile.generation || '—' }}</strong>
            </div>
            <div class="clr-form-control pr-reason">
              <label for="readiness-reason" class="clr-control-label">승인/검증 사유</label>
              <div class="clr-control-container"><div class="clr-textarea-wrapper">
                <textarea id="readiness-reason" clrTextarea name="reason" [(ngModel)]="reason" placeholder="관리 작업의 목적과 근거를 8자 이상 입력"></textarea>
              </div></div>
            </div>
            <div class="pr-actions">
              <button class="btn" type="button" [disabled]="busy() || reason.trim().length < 8" (click)="preflight()">프로파일 사전 점검</button>
              <button class="btn btn-primary" type="button" [disabled]="busy() || !s.profile.declared || reason.trim().length < 8" (click)="verify()">증거 재검증</button>
            </div>
          </div>
        </section>
      </div>

      <section class="pr-capabilities" aria-labelledby="capabilities-title">
        <div class="pr-section-heading">
          <div><span class="pr-eyebrow">CAPABILITY EVIDENCE</span><h2 id="capabilities-title">필수 지원 프로파일</h2></div>
          <span class="pr-sub">서버 실측 증거가 없는 조건은 Ready가 될 수 없습니다.</span>
        </div>
        <clr-accordion [clrAccordionMultiPanel]="true">
          @for (cap of s.capabilities; track cap.type) {
            <clr-accordion-panel>
              <clr-accordion-title>
                <span class="pr-cap-title"><span class="pr-dot" [class.ok]="cap.ready"></span>{{ capabilityLabel(cap.type) }}</span>
                <span class="label" [class.label-success]="cap.ready" [class.label-danger]="!cap.ready">{{ cap.ready ? 'Verified' : cap.reason }}</span>
              </clr-accordion-title>
              <clr-accordion-content *clrIfExpanded>
                <p>{{ cap.message }}</p>
                <pre>{{ evidenceText(cap) }}</pre>
              </clr-accordion-content>
            </clr-accordion-panel>
          }
        </clr-accordion>
      </section>

      <section class="pr-admission" [class.unlocked]="s.admission.foundationActivationAllowed" aria-label="PFS 활성화 게이트">
        <div>
          <span class="pr-eyebrow">PFS ADMISSION</span>
          <h2>Foundation 활성화 {{ s.admission.foundationActivationAllowed ? '허용' : '차단' }}</h2>
          <p>{{ s.admission.foundationActivationOverride ? '개발 예외로 Foundation subShell만 활성화할 수 있습니다. PFS plugin은 계속 잠깁니다.' : (s.admission.foundationActivationAllowed ? 'Extensions에서 사전 설치된 Foundation subShell을 정식 활성화할 수 있습니다.' : 'Foundation은 Ready 상태로 사전 설치할 수 있지만, HIS와 4개 지원 역량 검증 전에는 활성화되지 않습니다.') }}</p>
        </div>
        @if (s.admission.foundationActivationAllowed) {
          <a class="btn btn-primary" routerLink="/manage/extensions">Foundation 활성화로 이동</a>
        } @else {
          <div class="btn-group"><a class="btn" routerLink="/manage/extensions">Foundation 사전 설치</a><a class="btn" routerLink="/p/cluster-manager/his/his">HIS 구성</a></div>
        }
      </section>
    } @else {
      <div class="progress loop"><progress></progress></div>
    }
  `,
  styles: [`
    :host { display: block; max-width: 88rem; }
    .pr-summary, .pr-admission { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; padding: 1.15rem 1.25rem; border: 1px solid var(--os-hairline); background: #fff; }
    .pr-summary { border-top: 3px solid var(--os-error); }
    .pr-summary:has(.label-success) { border-top-color: var(--os-success); }
    .pr-summary h2, .pr-admission h2 { margin: .35rem 0 .2rem; font-size: 1.15rem; }
    .pr-summary p, .pr-admission p { margin: 0; color: var(--os-ink-muted); font-size: .78rem; }
    .pr-summary-meta { display: flex; flex-direction: column; align-items: flex-end; gap: .25rem; color: var(--os-ink-muted); font-size: .68rem; }
    .pr-lifecycle, .pr-capabilities { margin-top: 1rem; padding: 1.1rem 1.25rem; border: 1px solid var(--os-hairline); background: #fff; }
    .pr-section-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-end; margin-bottom: .8rem; }
    .pr-section-heading h2 { margin: .15rem 0 0; font-size: 1rem; }
    .pr-eyebrow { color: var(--os-accent); font-size: .62rem; font-weight: 700; letter-spacing: .09em; }
    .pr-sub { color: var(--os-ink-muted); font-size: .7rem; }
    .pr-lifecycle ol { display: grid; grid-template-columns: repeat(7, minmax(8rem, 1fr)); gap: .4rem; list-style: none; padding: 0; margin: 0; overflow-x: auto; }
    .pr-lifecycle li { min-height: 5.5rem; padding: .65rem; border: 1px solid var(--os-hairline); background: var(--os-surface-1); display: grid; grid-template-columns: auto 1fr; gap: .45rem; align-content: start; }
    .pr-lifecycle li.ready { border-color: var(--os-success); background: #f2fbf6; }
    .pr-lifecycle li.available { border-color: var(--os-accent); }
    .pr-step-no { display: inline-flex; width: 1.25rem; height: 1.25rem; align-items: center; justify-content: center; border-radius: 50%; background: #dfe3e6; font-size: .66rem; font-weight: 700; }
    .ready .pr-step-no { background: var(--os-success); color: #fff; }
    .pr-lifecycle strong, .pr-lifecycle span { display: block; }
    .pr-lifecycle strong { font-size: .72rem; line-height: 1.3; }
    .pr-lifecycle div span { margin-top: .25rem; color: var(--os-ink-muted); font-size: .62rem; line-height: 1.35; }
    .pr-lifecycle .label { grid-column: 2; justify-self: start; }
    .pr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem; }
    .card { margin: 0; }
    .card-header { font-size: .9rem; }
    .pr-check-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .65rem; padding: .55rem 0; border-bottom: 1px solid var(--os-hairline); }
    .pr-check-row:last-child { border-bottom: 0; }
    .pr-check-row strong, .pr-check-row span { display: block; }
    .pr-check-row strong { font-size: .76rem; }
    .pr-check-row div span { color: var(--os-ink-muted); font-size: .66rem; margin-top: .15rem; }
    .pr-dot { width: .65rem; height: .65rem; border-radius: 50%; background: var(--os-error); flex: 0 0 auto; }
    .pr-dot.ok { background: var(--os-success); }
    .pr-profile-meta { display: grid; grid-template-columns: auto 1fr; gap: .4rem .8rem; font-size: .72rem; }
    .pr-profile-meta span { color: var(--os-ink-muted); }
    .pr-reason { margin-top: .75rem; }
    textarea { width: 100%; min-height: 3.5rem; }
    .pr-actions { display: flex; gap: .4rem; margin-top: .65rem; }
    .pr-cap-title { display: inline-flex; align-items: center; gap: .5rem; }
    clr-accordion-title .label { margin-left: .6rem; }
    pre { max-height: 14rem; overflow: auto; padding: .65rem; border: 1px solid var(--os-hairline); background: var(--os-surface-1); font: .65rem/1.45 monospace; white-space: pre-wrap; }
    .pr-admission { margin-top: 1rem; border-left: 4px solid var(--os-error); }
    .pr-admission.unlocked { border-left-color: var(--os-success); }
    @media (max-width: 72rem) { .pr-grid { grid-template-columns: 1fr; } .pr-lifecycle ol { grid-template-columns: repeat(7, 10rem); } }
  `],
})
export class AdminPlatformReadiness implements OnInit {
  private api = inject(PlatformReadinessService);
  readonly state = signal<PlatformReadinessStatus | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  reason = '';

  ngOnInit(): void { void this.refresh(); }

  async refresh(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try { this.state.set(await this.api.status()); }
    catch (error) { this.error.set(String(error)); }
    finally { this.busy.set(false); }
  }

  async preflight(): Promise<void> { await this.mutate('preflight'); }
  async verify(): Promise<void> { await this.mutate('verify'); }

  private async mutate(operation: 'preflight' | 'verify'): Promise<void> {
    if (this.reason.trim().length < 8) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      const next = operation === 'preflight' ? await this.api.preflight(this.reason.trim()) : await this.api.verify(this.reason.trim());
      this.state.set(next);
      this.notice.set(operation === 'preflight' ? 'PlatformSupportProfile 사전 점검을 기록했습니다.' : `증거 검증 완료: ${next.phase}`);
      this.reason = '';
    } catch (error) { this.error.set(String(error)); }
    finally { this.busy.set(false); }
  }

  nextBlocker(state: PlatformReadinessStatus): string {
    const prerequisite = state.prerequisites.find((item) => !item.ready);
    if (prerequisite) return `${prerequisite.label}: ${prerequisite.detail}`;
    const capability = state.capabilities.find((item) => !item.ready);
    if (capability) return `${this.capabilityLabel(capability.type)}: ${capability.message}`;
    return state.profile.declared ? '지원 프로파일 증거 재검증이 필요합니다.' : 'PlatformSupportProfile 사전 점검을 시작하세요.';
  }

  capabilityLabel(type: string): string {
    return ({ Delivery: '전달·Desired State', Observability: '관측 가능성', BackupRestore: '백업·복구', SecurityPolicy: '보안·정책' } as Record<string, string>)[type] || type;
  }

  evidenceText(capability: ReadinessCondition): string {
    return JSON.stringify(capability.evidence?.[0] || {}, null, 2);
  }

  displayTime(value: string): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR');
  }

  // Kept explicit for template type inference and future lifecycle action mapping.
  lifecycleTrack(step: ReadinessLifecycle): string { return step.key; }
}
