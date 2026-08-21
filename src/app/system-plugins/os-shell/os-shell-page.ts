import { ChangeDetectionStrategy, Component, DestroyRef, Input, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { OsShellReadinessService } from './os-shell-readiness.service';
import { OsShellSessionService } from './os-shell-session.service';
import { OsShellTerminalSurface } from './os-shell-terminal-surface';
import type { OsShellAttachState, OsShellSession } from './os-shell.types';

const ATTACHABLE_STATES = new Set(['Ready', 'Running', 'Attached', 'Provisioned']);
const TERMINAL_STATES = new Set(['Terminated', 'Failed', 'Revoked', 'Expired']);

@Component({
  selector: 'os-shell-page',
  imports: [ClarityModule, OsShellTerminalSurface],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="shell-page" [class.embedded]="embedded" aria-label="OS Shell session">
      @if (!embedded) {
        <header class="shell-heading">
        <div class="shell-identity">
          <div class="shell-mark" aria-hidden="true">&gt;_</div>
          <div>
            <div class="eyebrow">CONSOLE TERMINAL</div>
            <h1 id="os-shell-title">OS Shell</h1>
            <p>현재 Console 권한으로 실행되는 격리형 <code>os</code> 관리 터미널</p>
          </div>
        </div>
        <div class="shell-heading-actions">
          <div class="runtime-state" [attr.data-state]="readiness.status().state">
            <span class="status-dot" aria-hidden="true"></span>
            <span>Runtime</span><strong>{{ readiness.status().state }}</strong>
          </div>
          @if (standalone) {
            <a class="btn btn-sm" href="/" (click)="leaveStandalone($event)">Console로 돌아가기</a>
          }
        </div>
        </header>
      }

      @if (message()) {
        <clr-alert [clrAlertType]="messageType()" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">{{ message() }}</span></clr-alert-item>
        </clr-alert>
      }

      @if (!readiness.status().ready) {
        <section class="blocked-card" role="status">
          <div>
            <div class="state-code">{{ readiness.status().blocker?.code || readiness.status().state }}</div>
            <h2>OS Shell을 시작할 수 없습니다</h2>
            <p>{{ readiness.status().blocker?.message }}</p>
          </div>
          <dl>
            <dt>Owner</dt><dd>{{ readiness.status().blocker?.owner || 'cbss-main-shell' }}</dd>
            <dt>Next action</dt><dd>{{ readiness.status().blocker?.nextAction }}</dd>
            <dt>Freshness</dt><dd>{{ readiness.status().freshness }}</dd>
            <dt>Session class</dt><dd>{{ readiness.status().sessionClass }}</dd>
            <dt>Runtime adapter</dt><dd>{{ readiness.status().runtimeAdapterId }}</dd>
          </dl>
          <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="refresh()">다시 확인</button>
        </section>
      } @else {
        <section class="session-toolbar" aria-label="OS Shell session control">
          <div class="session-facts">
            <span><small>Session</small><strong>{{ session()?.sessionId || '없음' }}</strong></span>
            <span><small>State</small><strong>{{ session()?.observedState || attachState() }}</strong></span>
            <span><small>Network</small><strong>console-only</strong></span>
            <span><small>Expires</small><strong>{{ session()?.expiresAt || '—' }}</strong></span>
          </div>
          <div class="session-actions">
            @if (!session()) {
              @if (messageType() === 'danger') {
                <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="createSession()">다시 시작</button>
              } @else {
                <span class="auto-start" role="status">호출 즉시 자동 시작 중</span>
              }
            } @else {
              <button class="btn btn-danger-outline" type="button" [disabled]="busy()" (click)="terminateSession()">세션 종료</button>
            }
            <button class="btn btn-sm" type="button" [disabled]="busy()" (click)="refresh()">상태 새로고침</button>
          </div>
        </section>

        @if (session(); as active) {
          @if (attachable()) {
            <div class="terminal-wrap">
              <os-shell-terminal-surface [sessionId]="active.sessionId" (stateChange)="onAttachState($event)" />
            </div>
          } @else {
            <section class="provisioning" role="status">
              <div class="spinner spinner-md">Loading…</div>
              <h2>격리 실행 환경을 준비하고 있습니다</h2>
              <p>{{ active.observedState }} · generation {{ active.generation }} · fencing {{ active.fencingEpoch }}</p>
              <button class="btn btn-sm" type="button" (click)="pollSession()">지금 확인</button>
            </section>
          }
        } @else {
          <section class="empty-terminal">
            <code>$ os</code>
            <h2>사용자 전용 격리 세션을 준비하고 있습니다</h2>
            <p>OS Shell 호출과 함께 세션 생성과 연결을 자동으로 시작합니다.</p>
          </section>
        }
      }

      <footer class="release-evidence">
        <span>Runtime image <code>{{ readiness.status().release.runtimeImageDigest || '미보고' }}</code></span>
        <span>os artifact <code>{{ readiness.status().release.osArtifactDigest || '미보고' }}</code></span>
        <span>Policy <code>{{ readiness.status().release.sessionPolicyRevision || '미보고' }}</code></span>
      </footer>
    </section>
  `,
  styleUrl: './os-shell-page.scss',
})
export class OsShellPage {
  @Input() standalone = false;
  @Input() embedded = false;
  readonly readiness = inject(OsShellReadinessService);
  private readonly sessions = inject(OsShellSessionService);
  private readonly destroyRef = inject(DestroyRef);
  readonly session = signal<OsShellSession | null>(null);
  readonly attachState = signal<OsShellAttachState>('Idle');
  readonly busy = signal(false);
  readonly message = signal('');
  readonly messageType = signal<'info' | 'success' | 'warning' | 'danger'>('info');
  readonly attachable = computed(() => {
    const current = this.session();
    return Boolean(current && ATTACHABLE_STATES.has(current.observedState));
  });
  private pollTimer?: number;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer);
    });
    void this.initialize();
  }

  leaveStandalone(event: MouseEvent): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Never turn this extension-free realm into the ordinary plugin-bearing
    // SPA. A full navigation preserves history and constructs a fresh realm.
    window.location.assign('/');
  }

  async refresh(): Promise<void> {
    this.busy.set(true);
    this.message.set('');
    try {
      const readiness = await this.readiness.refresh();
      if (readiness.ready && this.session()) await this.pollSession();
    } finally {
      this.busy.set(false);
    }
  }

  async createSession(): Promise<void> {
    if (!this.readiness.status().ready || this.busy()) return;
    this.busy.set(true);
    this.message.set('');
    try {
      const created = await this.sessions.create();
      this.session.set(created);
      this.messageType.set('success');
      this.message.set('OS Shell 세션 요청이 접수되었습니다. runtime이 준비되면 자동으로 연결합니다.');
      if (!ATTACHABLE_STATES.has(created.observedState)) this.schedulePoll();
    } catch (error) {
      this.messageType.set('danger');
      this.message.set(`세션을 시작하지 못했습니다: ${error instanceof Error ? error.message : 'SessionCreateFailed'}`);
    } finally {
      this.busy.set(false);
    }
  }

  async pollSession(): Promise<void> {
    const current = this.session();
    if (!current) return;
    try {
      const observed = await this.sessions.get(current.sessionId);
      this.session.set(observed);
      if (!ATTACHABLE_STATES.has(observed.observedState) && !TERMINAL_STATES.has(observed.observedState)) this.schedulePoll();
    } catch (error) {
      this.messageType.set('warning');
      this.message.set(`세션 상태를 확인하지 못했습니다: ${error instanceof Error ? error.message : 'SessionWatchFailed'}`);
    }
  }

  async terminateSession(): Promise<void> {
    const current = this.session();
    if (!current || this.busy()) return;
    this.busy.set(true);
    this.attachState.set('Terminating');
    try {
      await this.sessions.terminate(current.sessionId);
      this.session.set(null);
      this.attachState.set('Terminated');
      this.messageType.set('success');
      this.message.set('OS Shell 세션 종료를 요청했습니다. CBSS가 runtime과 임시 home을 정리합니다.');
    } catch (error) {
      this.attachState.set('Failed');
      this.messageType.set('danger');
      this.message.set(`세션을 종료하지 못했습니다: ${error instanceof Error ? error.message : 'SessionTerminateFailed'}`);
    } finally {
      this.busy.set(false);
    }
  }

  onAttachState(event: { state: OsShellAttachState; detail?: string }): void {
    this.attachState.set(event.state);
    if (event.state === 'Revoked' || event.state === 'Failed') {
      this.messageType.set(event.state === 'Revoked' ? 'warning' : 'danger');
      this.message.set(event.detail ? `${event.state}: ${event.detail}` : event.state);
    }
  }

  private async initialize(): Promise<void> {
    const readiness = await this.readiness.refresh();
    if (!readiness.ready) return;
    try {
      const existing = await this.sessions.list();
      const resumable = existing.find((item) => !TERMINAL_STATES.has(item.observedState));
      if (resumable) {
        this.session.set(resumable);
        if (!ATTACHABLE_STATES.has(resumable.observedState)) this.schedulePoll();
        return;
      }
    } catch {
      // Session creation remains idempotent and quota-fenced when a transient
      // list failure prevents the client from finding a resumable session.
    }
    await this.createSession();
  }

  private schedulePoll(): void {
    if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollSession();
    }, 1500);
  }
}
