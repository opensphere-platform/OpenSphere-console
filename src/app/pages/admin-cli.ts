import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { OsPageHeader } from '../os/os-page-header';
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

@Component({
  selector: 'os-admin-cli',
  imports: [ClarityModule, OsPageHeader],
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
    </div>
  `,
})
export class AdminCli {
  private readonly http = inject(HttpService);
  readonly manifest = signal<CliManifest | null>(null);
  readonly error = signal('');

  constructor() {
    void this.load();
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

  osLabel(value: string): string {
    return { linux: 'Linux', darwin: 'macOS', windows: 'Windows' }[value] || value;
  }

  filename(href: string): string {
    return href.split('/').pop() || 'os';
  }
}
