import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { OsActionDialog } from '../os/os-action-dialog';
import { OsPageHeader } from '../os/os-page-header';

interface ReleaseComponent {
  repository: string;
  image: string;
  sourceRevision: string;
  registryCredentialsRequired?: boolean;
}

interface ReleaseLock {
  apiVersion: string;
  kind: string;
  channel: 'edge' | 'candidate' | 'stable' | 'ga';
  releaseDigest: string;
  resolvedAt?: string;
  source: string;
  sourceRevision: string;
  trust: { buildAuthority?: string; releaseClass?: string };
  releaseScope?: 'integrated' | 'component';
  baseReleaseDigest?: string;
  changedComponents?: string[];
  components: Record<string, ReleaseComponent>;
}

const SUPPORTED_RELEASE_CHANNELS = new Set(['edge']);

interface ReleaseSummary {
  channel: string;
  releaseDigest: string;
  sourceRevision: string;
  resolvedAt: string | null;
  componentCount: number;
  buildAuthority: string | null;
  releaseClass: string | null;
  releaseScope: 'integrated' | 'component';
  baseReleaseDigest: string | null;
  changedComponents: string[];
  components: Record<string, ReleaseComponent>;
}

interface ReleaseChange {
  request_id: string;
  action: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  k8s_operation_id: string | null;
  execution: {
    pull_number: number | null;
    pull_url: string | null;
    reconciler_status: string;
    drift_status: string;
    last_error: string | null;
  } | null;
  receipt: {
    succeeded: boolean;
    result: string;
    received_at: string;
    evidence: Record<string, unknown>;
  } | null;
}

interface ReleaseStatus {
  authority: {
    declaration: string;
    execution: string;
    observed: string;
    localKubeconfigExecution: boolean;
    supportedChannels: string[];
    blockedChannels: Record<string, string>;
  };
  execution: {
    ready: boolean;
    state: string;
    blocker: string | null;
    executorImage: string | null;
    desiredReplicas: number | null;
    availableReplicas: number | null;
  };
  current: ReleaseSummary;
  contract: { status: string; reconciler: string; metadata: Record<string, unknown> } | null;
  changes: ReleaseChange[];
  checkedAt: string;
}

@Component({
  selector: 'os-admin-platform-release',
  imports: [ClarityModule, FormsModule, RouterLink, OsPageHeader, OsActionDialog],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page release-page">
      <os-page-header title="Platform Release" tag="Console-governed install · upgrade · rollback" />
      <div class="lead">
        <p>관리자가 서명된 OpenSphere Release Lock을 검토하고 적용 요청을 생성합니다. 브라우저나 로컬 CLI가 Kubernetes를 직접 변경하지 않으며, 교차 승인된 Gitea 선언만 전용 executor가 적용합니다.</p>
        <button class="btn btn-sm btn-outline" type="button" [disabled]="busy()" (click)="refresh()">다시 확인</button>
      </div>

      @if (message(); as notice) {
        <clr-alert [clrAlertType]="notice.type" [clrAlertClosable]="true" (clrAlertClosedChange)="message.set(null)">
          <clr-alert-item><span class="alert-text">{{ notice.text }}</span></clr-alert-item>
        </clr-alert>
      }

      @if (status(); as state) {
        <section class="truth-rail" aria-label="Platform Release 권위">
          <div><span>현재 Channel</span><strong>{{ state.current.channel }}</strong><small>{{ state.current.releaseClass || '미보고' }}</small></div>
          <div><span>Release Digest</span><strong class="mono">{{ short(state.current.releaseDigest) }}</strong><small>{{ state.current.componentCount }} components</small></div>
          <div><span>Source Revision</span><strong class="mono">{{ short(state.current.sourceRevision) }}</strong><small>{{ state.current.buildAuthority || '미보고' }}</small></div>
          <div><span>실행 경계</span><strong>{{ state.execution.state }}</strong><small>{{ state.authority.execution }} · local kubeconfig {{ state.authority.localKubeconfigExecution ? '사용' : '사용 안 함' }}</small></div>
        </section>
        @if (!state.execution.ready) {
          <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">설치 실행기는 현재 사용할 수 없습니다: {{ state.execution.blocker || '원인 미보고' }}. 상태를 복구하기 전에는 요청을 생성하지 않습니다.</span></clr-alert-item>
          </clr-alert>
        }
        <p class="channel-boundary">현재 transactional 설치 지원 channel은 <strong>edge</strong>입니다. candidate·stable은 통합 복구 drill, GA는 signed GA lock 설치 지원이 마련될 때까지 의도적으로 닫혀 있습니다.</p>
      }

      <div class="workspace">
        <section class="request-card">
          <header>
            <div><span class="eyebrow">REVIEWED TARGET</span><h2>Release Lock 검토</h2></div>
            <label class="btn btn-sm btn-outline file-button">JSON 파일 열기<input type="file" accept="application/json,.json" (change)="loadFile($event)" /></label>
          </header>
          <section class="component-builder">
            <div class="builder-heading">
              <div>
                <span class="eyebrow">AFFECTED COMPONENTS ONLY</span>
                <h3>현재 설치 상태에서 Component Target 생성</h3>
                <p>게시가 끝난 구성요소의 exact digest만 추가합니다. 선택하지 않은 구성요소는 현재 설치 lock에서 그대로 계승됩니다.</p>
              </div>
              <button class="btn btn-sm btn-primary" type="button" [disabled]="!canGenerateComponentTarget() || generating()" (click)="pendingGenerate.set(true)">Component Lock 생성</button>
            </div>
            <div class="builder-inputs">
              <label>새 Source Revision
                <input clrInput [(ngModel)]="componentSourceRevision" placeholder="40자리 git commit SHA" />
              </label>
              <label>구성요소
                <select clrSelect [(ngModel)]="componentName">
                  <option value="">선택</option>
                  @for (name of componentOptions(); track name) {
                    <option [value]="name">{{ name }}</option>
                  }
                </select>
              </label>
              <label>게시된 Exact Digest
                <input clrInput [(ngModel)]="componentImage" placeholder="sha256:… 또는 ghcr.io/…@sha256:…" />
              </label>
              <button class="btn btn-sm btn-outline" type="button" [disabled]="!componentName || !componentImage.trim()" (click)="addComponentEvidence()">변경에 추가</button>
            </div>
            @if (builderError()) { <p class="validation danger">{{ builderError() }}</p> }
            <div class="draft-list">
              @for (name of componentDraftNames(); track name) {
                <div>
                  <strong>{{ name }}</strong>
                  <code>{{ componentDraft()[name]?.image }}</code>
                  <button class="btn btn-sm btn-link" type="button" (click)="removeComponentEvidence(name)">제거</button>
                </div>
              } @empty {
                <p>변경할 게시 이미지가 아직 추가되지 않았습니다.</p>
              }
            </div>
          </section>
          <div class="form-grid">
            <label>작업
              <select clrSelect [(ngModel)]="action">
                <option value="apply">Upgrade / Apply</option>
                <option value="rollback">Rollback</option>
              </select>
            </label>
            <label>전체 Target Release Lock JSON · 통합 release 또는 과거 rollback
              <textarea clrTextarea rows="12" [(ngModel)]="releaseText" (ngModelChange)="parseRelease()" placeholder="통합 OpenSphereReleaseLock을 붙여 넣거나 위에서 Component Lock을 생성하세요."></textarea>
            </label>
          </div>
          @if (parseError()) { <p class="validation danger">{{ parseError() }}</p> }
          @if (target(); as targetLock) {
            <dl class="target-summary">
              <div><dt>Channel</dt><dd>{{ targetLock.channel }}</dd></div>
              <div><dt>Release</dt><dd class="mono">{{ targetLock.releaseDigest }}</dd></div>
              <div><dt>Source</dt><dd class="mono">{{ targetLock.sourceRevision }}</dd></div>
              <div><dt>Scope / Components</dt><dd>{{ targetLock.releaseScope || 'integrated' }} · {{ componentNames(targetLock).length }}</dd></div>
            </dl>
            <div class="change-list">
              <h3>변경 구성요소 <span>{{ changedComponents().length }}</span></h3>
              @for (name of changedComponents(); track name) {
                <div><strong>{{ name }}</strong><code>{{ short(targetLock.components[name]?.image) }}</code></div>
              } @empty {
                <p>현재 설치 잠금과 같은 release입니다. 적용 요청을 만들 수 없습니다.</p>
              }
            </div>
          }
          <footer>
            <p>서명·SBOM·지원 platform·현재 설치 잠금은 executor가 다시 검증하며, 실패하면 검증된 이전 release를 복원합니다.</p>
            <button class="btn btn-primary" type="button" [disabled]="!canSubmit() || submitting()" (click)="pendingSubmit.set(true)">검토 요청 생성</button>
          </footer>
        </section>

        <aside class="boundary-card">
          <span class="eyebrow">AUTHORITY BOUNDARY</span>
          <h2>누가 무엇을 하는가</h2>
          <ol>
            <li><strong>관리자</strong><span>Release Lock과 변경 범위 검토, 최근 AAL2로 요청</span></li>
            <li><strong>다른 관리자</strong><span>Gitea PR 교차 승인</span></li>
            <li><strong>Release reconciler</strong><span>승인된 선언만 exact-digest Job으로 전달</span></li>
            <li><strong>Executor</strong><span>공급망 검증, upgrade, 실패 시 자동 rollback</span></li>
            <li><strong>Kubernetes</strong><span>설치 잠금과 Ready 실측 영수증 제공</span></li>
          </ol>
          <a routerLink="/manage/state-changes">승인 및 전체 변경 이력 보기 →</a>
        </aside>
      </div>

      <section class="history">
        <header><div><span class="eyebrow">OBSERVED RECEIPTS</span><h2>Platform Release 이력</h2></div><a routerLink="/manage/state-changes">전체 상태 변경</a></header>
        <clr-datagrid>
          <clr-dg-column>요청</clr-dg-column><clr-dg-column>PR / reconcile</clr-dg-column><clr-dg-column>실측 결과</clr-dg-column><clr-dg-column>시간</clr-dg-column>
          @for (change of status()?.changes || []; track change.request_id) {
            <clr-dg-row>
              <clr-dg-cell><strong>{{ actionLabel(change.action) }}</strong><small class="mono">{{ short(change.request_id) }}</small></clr-dg-cell>
              <clr-dg-cell>{{ change.execution?.pull_number ? 'PR #' + change.execution?.pull_number : 'PR 대기' }}<small>{{ change.execution?.reconciler_status || change.status }}</small></clr-dg-cell>
              <clr-dg-cell><span [class]="verdictClass(change)">{{ verdict(change) }}</span><small>{{ change.receipt?.result || change.execution?.last_error || 'receipt 대기' }}</small></clr-dg-cell>
              <clr-dg-cell>{{ fmt(change.completed_at || change.created_at) }}</clr-dg-cell>
            </clr-dg-row>
          }
          <clr-dg-placeholder>Platform Release 요청이 없습니다.</clr-dg-placeholder>
        </clr-datagrid>
      </section>

      <os-action-dialog
        [open]="pendingSubmit()"
        title="Platform Release 검토 요청"
        [message]="confirmationMessage()"
        confirmLabel="Gitea PR 생성"
        [reasonRequired]="true"
        reasonLabel="변경 승인 사유"
        [busy]="submitting()"
        (confirmed)="submit($event)"
        (cancelled)="pendingSubmit.set(false)"
      />
      <os-action-dialog
        [open]="pendingGenerate()"
        title="Component Release Lock 생성"
        [message]="componentGenerationMessage()"
        confirmLabel="검증된 Target 생성"
        [reasonRequired]="true"
        reasonLabel="Target 생성 사유"
        [busy]="generating()"
        (confirmed)="generateComponentTarget($event)"
        (cancelled)="pendingGenerate.set(false)"
      />
    </div>
  `,
  styles: [`
    .release-page{display:grid;gap:.8rem}.lead{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--os-hairline);padding:.1rem 0 .75rem}.lead p{max-width:76rem;margin:0;color:#334e68;font-size:.82rem;line-height:1.55}.truth-rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--os-hairline);background:#fff}.truth-rail>div{display:grid;gap:.2rem;padding:.7rem .85rem;border-right:1px solid var(--os-hairline)}.truth-rail>div:last-child{border-right:0}.truth-rail span,.eyebrow{color:#486581;font-size:.62rem;font-weight:700;letter-spacing:.07em}.truth-rail strong{color:#102a43;font-size:.82rem}.truth-rail small{color:#627d98;font-size:.66rem}.channel-boundary{margin:0;color:#334e68;font-size:.7rem}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 21rem;gap:.8rem}.request-card,.boundary-card,.history{border:1px solid var(--os-hairline);background:#fff}.request-card>header,.history>header{display:flex;align-items:center;justify-content:space-between;padding:.75rem .85rem;border-bottom:1px solid var(--os-hairline)}h2{margin:.1rem 0 0;font-size:.95rem;color:#102a43}.file-button{position:relative;overflow:hidden}.file-button input{position:absolute;inset:0;opacity:0;cursor:pointer}.component-builder{margin:.8rem;padding:.8rem;border:1px solid #b8d7ea;background:#f7fbfe}.builder-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.builder-heading h3{margin:.12rem 0;font-size:.82rem;color:#102a43}.builder-heading p{margin:0;color:#486581;font-size:.68rem}.builder-inputs{display:grid;grid-template-columns:minmax(14rem,1.1fr) 10rem minmax(20rem,2fr) auto;gap:.55rem;align-items:end;margin-top:.75rem}.builder-inputs label{display:grid;gap:.25rem;color:#334e68;font-size:.68rem;font-weight:600}.builder-inputs input,.builder-inputs select{width:100%;max-width:none}.draft-list{display:grid;margin-top:.55rem}.draft-list>div{display:grid;grid-template-columns:10rem minmax(0,1fr) auto;align-items:center;gap:.5rem;padding:.3rem 0;border-top:1px solid #d9eaf4;font-size:.66rem}.draft-list code{overflow:hidden;text-overflow:ellipsis}.draft-list p{margin:.2rem 0 0;color:#7b8794;font-size:.66rem}.form-grid{display:grid;gap:.7rem;padding:.8rem}.form-grid label{display:grid;gap:.3rem;color:#334e68;font-size:.72rem;font-weight:600}.form-grid select,.form-grid textarea{width:100%;max-width:none}.form-grid textarea{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.68rem;line-height:1.45}.validation{margin:0 .8rem .6rem;font-size:.72rem}.component-builder .validation{margin:.45rem 0 0}.danger{color:#a32121}.target-summary{display:grid;grid-template-columns:8rem 1fr 1fr 10rem;margin:0 .8rem .7rem;border:1px solid #d9e2ec}.target-summary>div{padding:.55rem;border-right:1px solid #d9e2ec;min-width:0}.target-summary>div:last-child{border-right:0}.target-summary dt{font-size:.6rem;color:#627d98}.target-summary dd{margin:.18rem 0 0;overflow:hidden;text-overflow:ellipsis;font-size:.68rem}.change-list{margin:0 .8rem .8rem;border-top:1px solid #d9e2ec}.change-list h3{display:flex;gap:.4rem;margin:.65rem 0;font-size:.74rem}.change-list>div{display:grid;grid-template-columns:10rem 1fr;gap:.5rem;padding:.35rem 0;border-top:1px solid #f0f4f8;font-size:.66rem}.change-list code{overflow:hidden;text-overflow:ellipsis}.change-list p{color:#7b8794;font-size:.7rem}.request-card>footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.75rem .85rem;border-top:1px solid var(--os-hairline)}.request-card>footer p{max-width:52rem;margin:0;color:#486581;font-size:.68rem}.boundary-card{padding:.85rem}.boundary-card ol{display:grid;gap:.6rem;margin:.8rem 0;padding:0;list-style:none;counter-reset:step}.boundary-card li{display:grid;grid-template-columns:1.5rem 1fr;column-gap:.5rem;counter-increment:step}.boundary-card li:before{content:counter(step);grid-row:1/3;display:grid;place-items:center;width:1.35rem;height:1.35rem;border:1px solid #5aa7d5;border-radius:50%;color:#176b9c;font-size:.62rem}.boundary-card li strong{font-size:.72rem}.boundary-card li span{color:#486581;font-size:.66rem;line-height:1.4}.boundary-card a,.history a{color:#176b9c;font-size:.68rem;font-weight:600}.history clr-dg-cell{font-size:.7rem}.history clr-dg-cell small{display:block;margin-top:.18rem;color:#627d98}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.verdict{display:inline-block;border:1px solid #9fb3c8;border-radius:1rem;padding:.05rem .42rem}.verdict.ok{border-color:#65a30d;color:#3f6212}.verdict.danger{border-color:#dc2626;color:#991b1b}.verdict.waiting{border-color:#0284c7;color:#075985}@media(max-width:70rem){.workspace{grid-template-columns:1fr}.truth-rail{grid-template-columns:repeat(2,1fr)}.target-summary{grid-template-columns:1fr 1fr}.builder-inputs{grid-template-columns:1fr 1fr}}@media(max-width:44rem){.truth-rail,.target-summary,.builder-inputs{grid-template-columns:1fr}.lead,.request-card>footer,.builder-heading{align-items:flex-start;flex-direction:column}}
  `],
})
export class AdminPlatformRelease implements OnInit {
  readonly status = signal<ReleaseStatus | null>(null);
  readonly target = signal<ReleaseLock | null>(null);
  readonly parseError = signal('');
  readonly busy = signal(false);
  readonly submitting = signal(false);
  readonly pendingSubmit = signal(false);
  readonly pendingGenerate = signal(false);
  readonly generating = signal(false);
  readonly builderError = signal('');
  readonly componentDraft = signal<Record<string, { image: string }>>({});
  readonly message = signal<{ type: 'danger' | 'success' | 'warning' | 'info'; text: string } | null>(null);
  releaseText = '';
  action: 'apply' | 'rollback' = 'apply';
  componentSourceRevision = '';
  componentName = '';
  componentImage = '';
  private readonly http = inject(HttpService);

  readonly changedComponents = computed(() => {
    const current = this.status()?.current.components || {};
    const target = this.target()?.components || {};
    return [...new Set([...Object.keys(current), ...Object.keys(target)])]
      .filter((name) => current[name]?.image !== target[name]?.image)
      .sort();
  });

  readonly canSubmit = computed(() => Boolean(
    this.target()
    && this.status()?.contract
    && this.status()?.execution.ready
    && this.changedComponents().length
    && !this.parseError(),
  ));

  readonly componentDraftNames = computed(() => Object.keys(this.componentDraft()).sort());

  canGenerateComponentTarget(): boolean {
    return Boolean(
      /^[a-f0-9]{40}$/.test(this.componentSourceRevision.trim())
      && this.componentDraftNames().length
      && !this.builderError()
    );
  }

  async ngOnInit(): Promise<void> { await this.refresh(); }

  async refresh(): Promise<void> {
    this.busy.set(true);
    try {
      const response = await this.http.request('/api/platform/releases/status', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || `HTTP ${response.status}`));
      this.status.set(body as ReleaseStatus);
    } catch (error) {
      this.message.set({ type: 'danger', text: `Platform Release 상태 조회 실패: ${String(error)}` });
    } finally {
      this.busy.set(false);
    }
  }

  async loadFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      this.parseError.set('Release Lock 파일은 256 KiB를 초과할 수 없습니다.');
      return;
    }
    this.releaseText = await file.text();
    this.parseRelease();
  }

  parseRelease(): void {
    this.parseError.set('');
    this.target.set(null);
    if (!this.releaseText.trim()) return;
    try {
      const value = JSON.parse(this.releaseText) as ReleaseLock;
      if (value.apiVersion !== 'release.opensphere.io/v1alpha1'
        || value.kind !== 'OpenSphereReleaseLock'
        || !SUPPORTED_RELEASE_CHANNELS.has(value.channel)
        || !/^sha256:[a-f0-9]{64}$/.test(value.releaseDigest || '')
        || !/^[a-f0-9]{40}$/.test(value.sourceRevision || '')
        || !value.components || !Object.keys(value.components).length) {
        throw new Error('OpenSphereReleaseLock 필수 필드가 올바르지 않거나 현재 installer가 지원하지 않는 channel입니다.');
      }
      this.target.set(value);
    } catch (error) {
      this.parseError.set(`Release Lock 검증 실패: ${String(error)}`);
    }
  }

  componentOptions(): string[] {
    return Object.keys(this.status()?.current.components || {}).sort();
  }

  addComponentEvidence(): void {
    this.builderError.set('');
    const current = this.status()?.current.components || {};
    const name = this.componentName;
    const repository = current[name]?.repository;
    const raw = this.componentImage.trim();
    if (!repository) {
      this.builderError.set('현재 설치 lock에 존재하는 구성요소를 선택하세요.');
      return;
    }
    const image = /^sha256:[a-f0-9]{64}$/.test(raw)
      ? `ghcr.io/opensphere-platform/${repository}@${raw}`
      : raw;
    if (image !== `ghcr.io/opensphere-platform/${repository}@${image.split('@').at(-1)}`
      || !/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(image)) {
      this.builderError.set(`${name}의 공식 GHCR exact digest를 입력하세요.`);
      return;
    }
    this.componentDraft.update((value) => ({ ...value, [name]: { image } }));
    this.componentName = '';
    this.componentImage = '';
  }

  removeComponentEvidence(name: string): void {
    this.componentDraft.update((value) => {
      const next = { ...value };
      delete next[name];
      return next;
    });
  }

  componentGenerationMessage(): string {
    return `기준 release: ${this.status()?.current.releaseDigest || '미확인'}\n새 source: ${this.componentSourceRevision}\n변경: ${this.componentDraftNames().join(', ')}\n선택하지 않은 구성요소는 현재 lock을 그대로 계승합니다.`;
  }

  async generateComponentTarget(reason: string): Promise<void> {
    if (!this.canGenerateComponentTarget()) return;
    this.generating.set(true);
    try {
      const response = await this.http.request('/api/platform/releases/component-target', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceRevision: this.componentSourceRevision.trim(),
          components: this.componentDraft(),
          reason,
        }),
      });
      const body = await response.json().catch(() => ({})) as { targetLock?: ReleaseLock; error?: string };
      if (!response.ok || !body.targetLock) throw new Error(String(body.error || `HTTP ${response.status}`));
      this.releaseText = JSON.stringify(body.targetLock, null, 2);
      this.parseRelease();
      this.action = 'apply';
      this.pendingGenerate.set(false);
      this.message.set({
        type: 'success',
        text: `현재 설치 lock에 결속된 Component Target을 생성했습니다: ${body.targetLock.changedComponents?.join(', ') || '변경 미확인'}. 내용을 검토한 뒤 Gitea 승인 요청을 생성하세요.`,
      });
    } catch (error) {
      this.message.set({ type: 'danger', text: `Component Target 생성 실패: ${String(error)}` });
    } finally {
      this.generating.set(false);
    }
  }

  confirmationMessage(): string {
    const target = this.target();
    return target
      ? `${this.action === 'rollback' ? 'Rollback' : 'Upgrade'} 요청\n현재: ${this.status()?.current.releaseDigest || '미확인'}\n대상: ${target.releaseDigest}\n변경: ${this.changedComponents().join(', ')}\n요청자와 다른 관리자의 승인이 필요합니다.`
      : '';
  }

  async submit(reason: string): Promise<void> {
    const target = this.target();
    const current = this.status()?.current;
    if (!target || !current || !this.canSubmit()) return;
    this.submitting.set(true);
    try {
      const response = await this.http.request('/api/platform/changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          consumerId: 'platform-release',
          action: this.action,
          target: 'opensphere-platform',
          reason,
          desiredState: {
            contract: 'opensphere.platform.release/v1',
            previousReleaseDigest: current.releaseDigest,
            targetLock: target,
          },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || `HTTP ${response.status}`));
      this.pendingSubmit.set(false);
      this.message.set({
        type: 'success',
        text: `Platform Release 요청 ${body.requestId} · PR #${body.pullRequest?.number || '—'}을 생성했습니다. 다른 관리자의 교차 승인 후 전용 executor가 적용합니다.`,
      });
      await this.refresh();
    } catch (error) {
      this.message.set({ type: 'danger', text: `Platform Release 요청 실패: ${String(error)}` });
    } finally {
      this.submitting.set(false);
    }
  }

  componentNames(lock: ReleaseLock): string[] { return Object.keys(lock.components || {}).sort(); }
  short(value: string | null | undefined): string {
    const text = String(value || '');
    if (text.includes('@sha256:')) return `${text.split('@sha256:')[0]}@${text.slice(-12)}`;
    return text.length > 20 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text || '—';
  }
  fmt(value: string | null): string {
    if (!value) return '기록 없음';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium', hour12: false,
    }).format(date);
  }
  actionLabel(value: string): string { return value.replace(/^gitea:/, '') === 'rollback' ? 'Rollback' : 'Upgrade'; }
  verdict(change: ReleaseChange): string {
    if (change.receipt) return change.receipt.succeeded ? 'Observed' : 'Failed';
    if (change.execution?.last_error || change.status === 'failed') return 'Failed';
    return change.status === 'applied' ? 'Observed' : 'Awaiting';
  }
  verdictClass(change: ReleaseChange): string {
    const value = this.verdict(change);
    return `verdict ${value === 'Observed' ? 'ok' : value === 'Failed' ? 'danger' : 'waiting'}`;
  }
}
