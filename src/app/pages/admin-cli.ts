import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';
import { HttpService } from '../core/http.service';

interface CliLink {
  os: string;
  arch: string;
  text: string;
  href: string;
  size: number;
  sha256: string;
}

interface CliManifest {
  name: string;
  displayName: string;
  description: string;
  ownership: 'console-native';
  profile: 'admin';
  version: string;
  links: CliLink[];
  extensionBoundary: { workforce: string; adminTokenReuse: boolean };
}

// BFF가 발급하는 admin PAT — CLI 인증 토큰. 콘솔이 셀프서비스로 발급/조회/폐기한다(F-9).
interface Pat {
  jti: string;
  label: string;
  createdAt: string | null;
  expiresAt: string | null;
  user: string;
}
interface MintedPat {
  token: string;
  jti: string;
  label: string;
  expiresAt: string;
}

@Component({
  selector: 'os-admin-cli',
  imports: [ClarityModule, FormsModule, OsPageHeader, OsPanel],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="os — OpenSphere CLI" tag="Core · Console native" />
      <p class="os-sub">
        Console과 동일한 Registry·API·Kanidm PAT·RBAC·감사 경로를 사용하는 관리자 제어 표면입니다.
        <code>os</code> 자체는 Binding이 아니며 Main Shell이 직접 소유합니다.
      </p>

      @if (error(); as message) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">{{ message }}</span></clr-alert-item>
        </clr-alert>
      }

      @if (manifest(); as cli) {
        <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              <strong>{{ cli.displayName }} {{ cli.version }}</strong> · 프로파일 {{ cli.profile }} · 소유권 {{ cli.ownership }}
            </span>
          </clr-alert-item>
        </clr-alert>

        <clr-datagrid>
          <clr-dg-column>운영체제</clr-dg-column>
          <clr-dg-column>아키텍처</clr-dg-column>
          <clr-dg-column>아티팩트</clr-dg-column>
          <clr-dg-column>SHA-256</clr-dg-column>
          <clr-dg-column>다운로드</clr-dg-column>
          @for (link of cli.links; track link.href) {
            <clr-dg-row>
              <clr-dg-cell>{{ osLabel(link.os) }}</clr-dg-cell>
              <clr-dg-cell><code>{{ link.arch }}</code></clr-dg-cell>
              <clr-dg-cell><code>{{ filename(link.href) }}</code></clr-dg-cell>
              <clr-dg-cell><code title="{{ link.sha256 }}">{{ link.sha256.slice(0, 12) }}…</code></clr-dg-cell>
              <clr-dg-cell>
                <a class="btn btn-sm btn-primary" [href]="link.href" [attr.download]="filename(link.href)">{{ link.text }}</a>
              </clr-dg-cell>
            </clr-dg-row>
          }
          <clr-dg-placeholder>배포된 CLI 아티팩트가 없습니다</clr-dg-placeholder>
          <clr-dg-footer>{{ cli.links.length }}개 플랫폼 · Console native v{{ cli.version }}</clr-dg-footer>
        </clr-datagrid>

        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              향후 workforce 인증·권한·명령은 별도 Binding과 workforce 프로파일로 확장합니다.
              관리자 PAT를 workforce 토큰으로 재사용하지 않습니다.
            </span>
          </clr-alert-item>
        </clr-alert>
      } @else if (!error()) {
        <span class="spinner spinner-sm" aria-label="CLI manifest 불러오는 중"></span>
      }

      <!-- F-9: CLI 인증 토큰(PAT) 셀프서비스 발급 — 버튼 → 우측 슬라이딩 패널 -->
      <div class="os-h2-row">
        <h2 class="os-h2">CLI 인증 토큰 (PAT)</h2>
        <div class="head-actions">
          <button class="btn btn-sm btn-primary" (click)="openMint()">토큰 발급</button>
          <button class="btn btn-sm btn-link" (click)="loadPats()" [disabled]="busy()">새로고침</button>
        </div>
      </div>
      <p class="os-sub">
        <code>os</code> 로그인에 사용할 관리자 PAT를 발급합니다. 발급된 토큰은
        <strong>생성 직후 한 번만</strong> 표시되며 저장되지 않으니 안전한 곳에 보관하세요.
        토큰은 argv 노출 없는 <code>os login --pat-stdin</code>으로 입력하는 것을 권장합니다.
      </p>

      @if (patError() && !panelOpen(); as pe) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="true" (clrAlertClosedChange)="patError.set('')">
          <clr-alert-item><span class="alert-text">{{ pe }}</span></clr-alert-item>
        </clr-alert>
      }

      <clr-datagrid>
        <clr-dg-column>라벨</clr-dg-column>
        <clr-dg-column>토큰 ID (jti)</clr-dg-column>
        <clr-dg-column>발급</clr-dg-column>
        <clr-dg-column>만료</clr-dg-column>
        <clr-dg-column>동작</clr-dg-column>
        @for (p of pats(); track p.jti) {
          <clr-dg-row>
            <clr-dg-cell>{{ p.label || '(무라벨)' }}</clr-dg-cell>
            <clr-dg-cell><code title="{{ p.jti }}">{{ p.jti.slice(0, 12) }}…</code></clr-dg-cell>
            <clr-dg-cell>{{ fmt(p.createdAt) }}</clr-dg-cell>
            <clr-dg-cell>{{ fmt(p.expiresAt) }}</clr-dg-cell>
            <clr-dg-cell>
              <button class="btn btn-sm btn-danger-outline" (click)="revoke(p)" [disabled]="busy()">폐기</button>
            </clr-dg-cell>
          </clr-dg-row>
        }
        <clr-dg-placeholder>발급된 PAT가 없습니다</clr-dg-placeholder>
        <clr-dg-footer>{{ pats().length }}개 토큰</clr-dg-footer>
      </clr-datagrid>

      <!-- 우측 슬라이딩 패널 — 토큰 발급 + 1회 표시 -->
      <os-panel
        [open]="panelOpen()"
        title="CLI 토큰 발급"
        subtitle="admin PAT · os login --pat-stdin"
        (closed)="closePanel()"
      >
        <p class="os-sub">
          발급된 토큰은 <strong>생성 직후 한 번만</strong> 표시되며 저장되지 않습니다. argv 노출 없는
          <code>os login --pat-stdin</code>으로 입력하세요.
        </p>

        @if (patError(); as pe) {
          <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="true" (clrAlertClosedChange)="patError.set('')">
            <clr-alert-item><span class="alert-text">{{ pe }}</span></clr-alert-item>
          </clr-alert>
        }

        @if (!minted()) {
          <form clrForm clrLayout="vertical">
            <clr-input-container>
              <label>토큰 라벨</label>
              <input clrInput [(ngModel)]="newLabel" name="pat-label" placeholder="예: my-laptop" (keyup.enter)="mint()" [disabled]="busy()" maxlength="64" />
            </clr-input-container>
          </form>
          <div class="panel-actions">
            <button class="btn btn-primary" (click)="mint()" [disabled]="busy() || !newLabel.trim()">발급</button>
            <button class="btn btn-outline" (click)="closePanel()" [disabled]="busy()">닫기</button>
          </div>
        }

        @if (minted(); as m) {
          <div class="minted">
            <div><strong>토큰이 발급되었습니다 (label: {{ m.label }}).</strong> 만료: {{ fmt(m.expiresAt) }}</div>
            <div class="warn">이 토큰은 다시 표시되지 않습니다. 지금 복사해 보관하세요.</div>
            <label class="os-cap">CLI 로그인 명령 (복사해서 실행):</label>
            <pre class="token-cmd">{{ loginCmd(m.token) }}</pre>
            <div class="minted-actions">
              <button class="btn btn-sm btn-primary" (click)="copy(loginCmd(m.token))">로그인 명령 복사</button>
              <button class="btn btn-sm btn-outline" (click)="copy(m.token)">토큰만 복사</button>
              @if (copied()) { <span class="copied">복사됨 ✓</span> }
            </div>
            <div class="panel-actions">
              <button class="btn btn-outline" (click)="closePanel()">닫기</button>
            </div>
          </div>
        }
      </os-panel>
    </div>
  `,
  styles: [
    `
      .os-h2 { font-size: 0.95rem; margin: 0; }
      .os-h2-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 1.6rem 0 0.3rem; }
      .head-actions { display: flex; gap: 0.4rem; align-items: center; }
      .os-sub { color: var(--os-muted); font-size: 0.75rem; margin: 0 0 0.8rem; }
      .panel-actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
      .minted { display: flex; flex-direction: column; gap: 0.35rem; }
      .minted .warn { color: var(--os-error); font-weight: 600; }
      .os-cap { font-size: 0.68rem; color: var(--os-muted); margin-top: 0.2rem; }
      .token-cmd { background: var(--os-surface-1); color: var(--os-ink); font-family: var(--os-font-mono, monospace); padding: 0.5rem 0.6rem; border-radius: 3px; font-size: 0.7rem; white-space: pre-wrap; word-break: break-all; margin: 0; }
      .minted-actions { display: flex; gap: 0.4rem; align-items: center; }
      .copied { color: var(--os-success); font-size: 0.72rem; }
    `,
  ],
})
export class AdminCli {
  private readonly http = inject(HttpService);
  readonly manifest = signal<CliManifest | null>(null);
  readonly error = signal('');

  readonly pats = signal<Pat[]>([]);
  readonly minted = signal<MintedPat | null>(null);
  readonly patError = signal('');
  readonly busy = signal(false);
  readonly copied = signal(false);
  readonly panelOpen = signal(false);
  newLabel = '';

  constructor() {
    void this.load();
    void this.loadPats();
  }

  openMint(): void {
    this.newLabel = '';
    this.minted.set(null);
    this.patError.set('');
    this.panelOpen.set(true);
  }

  closePanel(): void {
    this.panelOpen.set(false);
    this.minted.set(null);
    this.patError.set('');
  }

  async load(): Promise<void> {
    try {
      const manifest = await this.http.json<CliManifest>('/api/cli/index.json', { cache: 'no-store' });
      if (manifest.ownership !== 'console-native' || manifest.profile !== 'admin') {
        throw new Error('CLI ownership contract mismatch');
      }
      this.manifest.set(manifest);
    } catch (error) {
      this.error.set(`CLI manifest를 불러오지 못했습니다: ${String(error)}`);
    }
  }

  async loadPats(): Promise<void> {
    try {
      const r = await this.http.request('/bff/pat');
      if (r.status === 401) {
        this.patError.set('PAT 관리는 관리자 권한이 필요합니다 (opensphere-console-admins).');
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { pats?: Pat[] };
      this.pats.set(j.pats ?? []);
    } catch (e) {
      this.patError.set(`PAT 목록을 불러오지 못했습니다: ${String(e)}`);
    }
  }

  async mint(): Promise<void> {
    const label = this.newLabel.trim();
    if (!label || this.busy()) return;
    this.busy.set(true);
    this.patError.set('');
    try {
      const r = await this.http.request('/bff/pat', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `label=${encodeURIComponent(label)}`,
      });
      if (r.status === 401) {
        this.patError.set('토큰 발급에는 관리자 권한이 필요합니다.');
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.minted.set((await r.json()) as MintedPat);
      this.newLabel = '';
      await this.loadPats();
    } catch (e) {
      this.patError.set(`토큰 발급 실패: ${String(e)}`);
    } finally {
      this.busy.set(false);
    }
  }

  async revoke(p: Pat): Promise<void> {
    if (!confirm(`토큰 '${p.label || p.jti}' 을(를) 폐기할까요? 이 토큰을 쓰는 CLI 세션은 즉시 거부됩니다.`)) return;
    this.busy.set(true);
    this.patError.set('');
    try {
      const r = await this.http.request(`/bff/pat/${encodeURIComponent(p.jti)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      await this.loadPats();
    } catch (e) {
      this.patError.set(`토큰 폐기 실패: ${String(e)}`);
    } finally {
      this.busy.set(false);
    }
  }

  loginCmd(token: string): string {
    return `echo "${token}" | os login --pat-stdin --console ${window.location.origin}`;
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      window.setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.patError.set('클립보드 복사에 실패했습니다. 수동으로 선택해 복사하세요.');
    }
  }

  fmt(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  osLabel(value: string): string {
    return { linux: 'Linux', darwin: 'macOS', windows: 'Windows' }[value] || value;
  }

  filename(href: string): string {
    return href.split('/').pop() || 'os';
  }
}
