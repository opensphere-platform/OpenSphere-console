import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { OsPageHeader } from '../os/os-page-header';

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

/** Console native 관리자 CLI 배포 표면. 사람의 자격 증명 관리는 내 프로필로 단일화한다. */
@Component({
  selector: 'os-admin-cli',
  imports: [ClarityModule, RouterLink, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="os — OpenSphere CLI" tag="Core · Console native" />
      <p class="os-sub">
        Console과 동일한 Registry·API·RBAC·감사 경로를 사용하는 관리자 제어 표면입니다.
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
              <clr-dg-cell><a class="btn btn-sm btn-primary" [href]="link.href" [attr.download]="filename(link.href)">{{ link.text }}</a></clr-dg-cell>
            </clr-dg-row>
          }
          <clr-dg-placeholder>배포된 CLI 아티팩트가 없습니다</clr-dg-placeholder>
          <clr-dg-footer>{{ cli.links.length }}개 플랫폼 · Console native v{{ cli.version }}</clr-dg-footer>
        </clr-datagrid>

        <section class="login-card" aria-labelledby="cli-login-title">
          <div>
            <h2 id="cli-login-title">지속되는 장치 신뢰로 로그인</h2>
            <p>
              처음 한 번 <code>os login</code>을 실행해 브라우저에서 장치를 승인하면 됩니다. 이후 개인 키는 Windows DPAPI,
              macOS Keychain 또는 Linux Secret Service에 보관되고, 명령 실행 때마다 15분 세션을 자동 교환합니다.
            </p>
          </div>
          <a class="btn btn-sm btn-outline" routerLink="/me" [queryParams]="{ tab: 'credentials' }">내 장치·자격 증명 관리</a>
        </section>

        <pre class="command">os login --console {{ origin }}</pre>

        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              자동화 API 토큰은 CI·무인 작업 전용입니다. 대화형 CLI 로그인을 위해 토큰을 반복 생성하거나 파일에 저장하지 않습니다.
              향후 workforce 인증·권한·명령은 별도 Binding과 workforce 프로파일로 확장합니다.
            </span>
          </clr-alert-item>
        </clr-alert>
      } @else if (!error()) {
        <span class="spinner spinner-sm" aria-label="CLI manifest 불러오는 중"></span>
      }
    </div>
  `,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.75rem; margin: 0 0 0.8rem; }
      .login-card { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-top: 1px solid var(--os-hairline); border-bottom: 1px solid var(--os-hairline); margin: 1.2rem 0 0.7rem; padding: 0.8rem 0; }
      .login-card h2 { font-size: 0.9rem; margin: 0 0 0.2rem; }
      .login-card p { color: var(--os-muted); font-size: 0.7rem; margin: 0; max-width: 52rem; }
      .command { background: var(--os-surface-1); border: 1px solid var(--os-hairline); color: var(--os-ink); font-family: var(--os-font-mono, monospace); font-size: 0.72rem; margin: 0 0 0.8rem; padding: 0.55rem 0.7rem; white-space: pre-wrap; }
      @media (max-width: 760px) { .login-card { align-items: flex-start; flex-direction: column; } }
    `,
  ],
})
export class AdminCli {
  private readonly http = inject(HttpService);
  readonly manifest = signal<CliManifest | null>(null);
  readonly error = signal('');
  readonly origin = window.location.origin;

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const manifest = await this.http.json<CliManifest>('/api/cli/index.json', { cache: 'no-store' });
      if (manifest.ownership !== 'console-native' || manifest.profile !== 'admin') throw new Error('CLI ownership contract mismatch');
      this.manifest.set(manifest);
    } catch (error) {
      this.error.set(`CLI manifest를 불러오지 못했습니다: ${String(error)}`);
    }
  }

  osLabel(value: string): string {
    return { linux: 'Linux', darwin: 'macOS', windows: 'Windows' }[value] || value;
  }

  filename(href: string): string {
    return href.split('/').pop() || 'os';
  }
}
