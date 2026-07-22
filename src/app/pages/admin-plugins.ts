import { Component, OnInit, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { OsPageHeader } from '../os/os-page-header';
import { OsRawIcon } from '../os/os-raw-icon';
import { OsPanel } from '../os/os-panel';
import { OsActionDialog } from '../os/os-action-dialog';
import { IconLibraryService } from '../os/icon-library.service';
import { ExtensionHostService } from '../core/extension-host.service';
import { PlatformReadinessService } from '../core/platform-readiness.service';
import {
  PluginControlClient,
  CatalogItem,
  Registration,
  AuditEvent,
  Binding,
  ExtensionInspection,
  RegistryCredentialStatus,
  ImageRevocation,
  IntegrationStatus,
} from '../core/plugin-control-client.service';

interface EffectiveExtensionState {
  label: string;
  detail: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}

interface IntegrationRow {
  key: string;
  label: string;
  status: IntegrationStatus;
}

interface StatusLayer {
  label: string;
  value: string;
  detail: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}

/** 위계 트리 노드 — console(mainShell) → subShell/plugin, + Bindings 분기(§2.7 shell→plugin 귀속 시각화). */
interface TreeNode {
  id: string;
  label: string;
  meta?: string;
  type: 'mainShell' | 'subShell' | 'plugin' | 'core' | 'binding' | 'group';
  phase?: string | null;
  children: TreeNode[];
  actionable: boolean;
}

/**
 * Admin Control Page (계획서 §7) — Catalog/Installed/Audit 탭.
 * 설치/비활성화/재활성화/삭제를 Control API로만 수행하고, 성공 후 Extension Host를
 * reload하여 메뉴를 런타임 갱신한다. 셸 이미지·파드는 불변(DUPA 합격 기준).
 */
@Component({
  selector: 'os-admin-plugins',
  imports: [RouterLink, ClarityModule, OsPageHeader, OsRawIcon, OsPanel, OsActionDialog],
  template: `
    <div class="os-page">
      <os-page-header title="Console Extensions" tag="Admin Control">
        <p>UI 플러그인(UIPluginPackage) + headless 바인딩(CLIDownload) 통합 인식·관리 — 셸 리빌드 없이</p>
      </os-page-header>

    @if (msg(); as m) {
      <clr-alert
        [clrAlertType]="m.type"
        [clrAlertClosable]="true"
        (clrAlertClosedChange)="msg.set(null)"
      >
        <clr-alert-item
          ><span class="alert-text">{{ m.text }}</span></clr-alert-item
        >
      </clr-alert>
    }

    <section class="manage-status-rail" aria-label="Extension 운영 상태">
      <div><span>Catalog</span><strong>{{ catalog().length }}</strong><small>서명된 패키지</small></div>
      <div><span>Active</span><strong class="ok">{{ countPhase('Activated') }}</strong><small>메뉴·workload 활성</small></div>
      <div><span>Ready</span><strong>{{ countPhase('Ready') }}</strong><small>활성화 대기</small></div>
      <div><span>Disabled</span><strong class="neutral">{{ countPhase('Disabled') }}</strong><small>운영 제외</small></div>
      <div><span>Failed</span><strong [class.danger]="countPhase('Failed') > 0">{{ countPhase('Failed') }}</strong><small>검토 필요</small></div>
      <div><span>Bindings</span><strong>{{ bindings().length }}</strong><small>headless channels</small></div>
    </section>

    <clr-accordion class="management-actions">
      <clr-accordion-panel>
        <clr-accordion-title>관리 작업</clr-accordion-title>
        <clr-accordion-description>설치 · Registry 자격증명 · Digest 철회</clr-accordion-description>
        <clr-accordion-content *clrIfExpanded>
    <section class="registry-access" aria-labelledby="registry-access-title">
      <div class="registry-access-head">
        <div>
          <h2 id="registry-access-title">Private GHCR access</h2>
          <p class="os-sub">공개 전환 없이 private OpenSphere 패키지를 검사하고 Kubernetes workload가 pull하도록 동일한 read-only 자격증명을 사용합니다. 토큰은 화면에 다시 표시되지 않습니다.</p>
        </div>
        @if (registryStatus(); as registry) {
          <span class="label" [class.label-success]="registry.configured">{{ registry.configured ? 'Configured' : 'Not configured' }}</span>
        }
      </div>
      <div class="registry-access-form">
        <div class="clr-form-control">
          <label for="registry-user" class="clr-control-label">GitHub username</label>
          <div class="clr-control-container"><div class="clr-input-wrapper">
            <input id="registry-user" #registryUser class="clr-input" [value]="registryStatus()?.username || ''" autocomplete="username" />
          </div></div>
        </div>
        <div class="clr-form-control">
          <label for="registry-token" class="clr-control-label">Package read token</label>
          <div class="clr-control-container"><div class="clr-input-wrapper">
            <input id="registry-token" #registryToken type="password" class="clr-input" autocomplete="new-password" placeholder="read:packages 권한 토큰" />
          </div></div>
        </div>
        <div class="clr-form-control">
          <label for="registry-reason" class="clr-control-label">Change reason</label>
          <div class="clr-control-container"><div class="clr-input-wrapper">
            <input id="registry-reason" #registryReason class="clr-input" placeholder="등록 또는 제거 승인 사유(8자 이상)" />
          </div></div>
        </div>
        <button class="btn btn-outline" [disabled]="registryToken.value.length < 20 || registryReason.value.trim().length < 8" (click)="configureRegistryCredentials(registryUser.value, registryToken.value, registryReason.value); registryToken.value = ''">저장</button>
        <button class="btn btn-danger-outline" [disabled]="!registryStatus()?.configured || registryReason.value.trim().length < 8" (click)="removeRegistryCredentials(registryReason.value)">제거</button>
      </div>
    </section>

    <section class="registry-access" aria-labelledby="revocation-title">
      <div class="registry-access-head">
        <div>
          <h2 id="revocation-title">OCI image revocation ledger</h2>
          <p class="os-sub">취약하거나 손상된 exact digest를 Supabase append-only 원장에 철회합니다. 철회는 수정·삭제할 수 없고 신규 설치 및 활성 Registry 투영을 차단합니다.</p>
        </div>
        <span class="label label-danger">Revoked {{ revocations().length }}</span>
      </div>
      <div class="registry-access-form">
        <div class="clr-form-control">
          <label for="revoke-image" class="clr-control-label">Repository digest</label>
          <div class="clr-control-container"><div class="clr-input-wrapper"><input id="revoke-image" #revokeImageRef class="clr-input" size="70" placeholder="ghcr.io/opensphere-platform/...@sha256:..." /></div></div>
        </div>
        <div class="clr-form-control">
          <label for="replacement-image" class="clr-control-label">Replacement digest (optional)</label>
          <div class="clr-control-container"><div class="clr-input-wrapper"><input id="replacement-image" #replacementImageRef class="clr-input" size="52" placeholder="same repository@sha256:..." /></div></div>
        </div>
        <div class="clr-form-control">
          <label for="revoke-reason" class="clr-control-label">Revocation reason</label>
          <div class="clr-control-container"><div class="clr-input-wrapper"><input id="revoke-reason" #revokeReason class="clr-input" placeholder="철회 근거(8자 이상)" /></div></div>
        </div>
        <button class="btn btn-danger" [disabled]="!revokeImageRef.value.includes('@sha256:') || revokeReason.value.trim().length < 8" (click)="revokeImage(revokeImageRef.value, replacementImageRef.value, revokeReason.value)">Digest 철회</button>
      </div>
      @if (revocations().length) {
        <table class="table table-compact">
          <thead><tr><th class="left">Image digest</th><th>Replacement</th><th>Actor</th><th>Time</th><th class="left">Reason</th></tr></thead>
          <tbody>@for (item of revocations(); track item.repository + item.digest) {
            <tr><td class="left os-mono">{{ item.repository }}&#64;{{ item.digest }}</td><td class="os-mono">{{ item.replacementDigest || '—' }}</td><td>{{ item.actor }}</td><td>{{ item.revokedAt }}</td><td class="left">{{ item.reason }}</td></tr>
          }</tbody>
        </table>
      }
    </section>

    <section class="oci-install" aria-labelledby="oci-install-title">
      <h2 id="oci-install-title">OCI 이미지로 설치</h2>
      <p class="os-sub">OpenSphere GHCR 이미지의 SDK 계약·서명·권한 프로필을 먼저 검증합니다. 채널(edge/candidate/stable)은 설치 전에 불변 digest로 해석되며, 메뉴 활성화는 별도 승인입니다.</p>
      <div class="clr-form-control">
        <label for="extension-image" class="clr-control-label">OCI image address</label>
        <div class="clr-control-container"><div class="clr-input-wrapper">
          <input id="extension-image" #imageRef class="clr-input" size="90" placeholder="ghcr.io/opensphere-platform/opensphere-shell-foundation:edge" />
        </div></div>
      </div>
      <div class="clr-form-control">
        <label for="extension-reason" class="clr-control-label">Approval reason</label>
        <div class="clr-control-container"><div class="clr-input-wrapper">
          <input id="extension-reason" #reasonRef class="clr-input" size="60" placeholder="설치 목적과 승인 근거(8자 이상)" />
        </div></div>
      </div>
      <button class="btn btn-outline" (click)="inspectImage(imageRef.value)">검증</button>
      <button class="btn btn-primary" [disabled]="!inspection() || inspection()?.requestedImage !== imageRef.value.trim()" (click)="installImage(imageRef.value, reasonRef.value)">설치</button>
      @if (inspection(); as plan) {
        <div class="inspection-plan" role="status">
          <strong>{{ plan.descriptor.displayName }} {{ plan.descriptor.version }}</strong>
          <span class="label label-success">Descriptor {{ plan.verification.descriptor }}</span>
          <span class="label label-success">Signature {{ plan.verification.signature }}</span>
          <span class="label label-success">Provenance {{ plan.verification.provenance }}</span>
          <span class="label label-success">SBOM {{ plan.verification.sbom }}</span>
          <span class="label">{{ plan.descriptor.permissionProfile }}</span>
          @if (plan.channel) { <span class="label label-info">{{ plan.channel }} → digest</span> }
          <span class="os-mono">{{ plan.image }}</span>
          <span class="os-mono">{{ plan.verification.platforms.join(', ') }}</span>
          @if (plan.registryCredentialsRequired) { <span class="label label-info">Private pull credential</span> }
          <span class="os-mono">{{ plan.descriptor.permissions.join(', ') }}</span>
        </div>
        @if (foundationActivationLocked(plan.descriptor.id)) {
          <clr-alert [clrAlertType]="'info'" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">Foundation은 Ready 상태까지 사전 설치할 수 있습니다. 메뉴 활성화는 Platform Support Profile Ready 이후에 허용됩니다. <a routerLink="/manage/platform-control">Control Plane에서 준비 상태 확인</a></span></clr-alert-item></clr-alert>
        }
      }
    </section>
        </clr-accordion-content>
      </clr-accordion-panel>
    </clr-accordion>

    <clr-tabs>
      <clr-tab>
        <button clrTabLink>구성도 Topology</button>
        <clr-tab-content>
          <p class="os-sub">
            shell → plugin 귀속 위계 (§2.7) — console(mainShell)가 subShell·plugin을 호스팅,
            Bindings는 shell 귀속 예외 범주
          </p>
          <div class="tree">
            @for (root of tree(); track root.id) {
              <div class="tn tn0 host">
                <button class="caret" (click)="toggle(root.id)">{{ exp(root.id) ? '▾' : '▸' }}</button>
                <span class="tt tt-{{ root.type }}">{{ typeLabel(root.type) }}</span>
                <strong class="tl">{{ root.label }}</strong>
                <span class="tm">{{ root.meta }}</span>
                <span class="tc">{{ root.children.length }}</span>
              </div>
              @if (exp(root.id)) {
                @for (c of root.children; track c.id) {
                  <div class="tn tn1">
                    @if (c.type === 'subShell') {
                      <button class="caret" (click)="toggle(c.id)">{{ exp(c.id) ? '▾' : '▸' }}</button>
                    } @else {
                      <span class="caret-sp"></span>
                    }
                    <span class="tt tt-{{ c.type }}">{{ typeLabel(c.type) }}</span>
                    <span class="tl cc-sel" (click)="select(c.id)">{{ c.label }}</span>
                    @if (c.phase) {
                      <span
                        class="label"
                        [class.label-success]="effectiveStateByName(c.id).tone === 'success'"
                        [class.label-warning]="effectiveStateByName(c.id).tone === 'warning'"
                        [class.label-danger]="effectiveStateByName(c.id).tone === 'danger'"
                        >{{ effectiveStateByName(c.id).label }}</span
                      >
                    }
                    @if (c.actionable && c.phase) {
                      @if (c.phase === 'Activated') {
                        <button class="btn btn-sm" (click)="run('disable', c.id)">Disable</button>
                      } @else {
                        <button class="btn btn-sm btn-success-outline" (click)="run('enable', c.id)">
                          Enable
                        </button>
                      }
                    }
                    <span class="tm">{{ c.meta }}</span>
                  </div>
                  @if (exp(c.id) && c.type === 'subShell') {
                    @for (g of c.children; track g.id) {
                      <div class="tn tn2">
                        <span class="caret-sp"></span><span class="tt tt-plugin">plugin</span>
                        <span class="tl cc-sel" (click)="select(g.id)">{{ g.label }}</span>
                        @if (g.phase) {
                          <span class="label"
                            [class.label-success]="effectiveStateByName(g.id).tone === 'success'"
                            [class.label-warning]="effectiveStateByName(g.id).tone === 'warning'"
                            [class.label-danger]="effectiveStateByName(g.id).tone === 'danger'">{{ effectiveStateByName(g.id).label }}</span>
                        }
                        <span class="tm">{{ g.meta }}</span>
                      </div>
                    } @empty {
                      <div class="tn tn2 empty">
                        모듈 없음 — 이 shell에 귀속된 plugin 미배포 (Phase 2 예정)
                      </div>
                    }
                  }
                }
              }
            }
          </div>
          <p class="os-sub">
            ⚠️ kind/hostRef가 데이터에 들어오기 전까지(§2.7 실현·§5.2) 위계는 scope·core·nav
            신호로 도출됩니다. hostRef가 채워지면 plugin이 정확히 host 아래로 중첩됩니다.
          </p>
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink>Installed</button>
        <clr-tab-content>
          <div class="status-guide">
            <strong>상태 읽는 법</strong>
            <span><i class="status-dot success"></i>서비스와 Console 연동 완료</span>
            <span><i class="status-dot warning"></i>실행 중이지만 메뉴 등 일부 연동 미노출</span>
            <span><i class="status-dot danger"></i>실패 또는 성능 저하</span>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th class="left">Extension</th>
                <th>Effective state</th>
                <th>Workload</th>
                <th>Global menu</th>
                <th>Integrations</th>
                <th>Channel</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (r of registrations(); track r.name) {
                <tr>
                  <td class="left">
                    <button type="button" class="extension-link" (click)="select(r.name)">{{ displayName(r.name) }}</button>
                    <div class="os-mono">{{ r.name }}</div>
                  </td>
                  <td>
                    <span
                      class="label"
                      [class.label-success]="effectiveState(r).tone === 'success'"
                      [class.label-warning]="effectiveState(r).tone === 'warning'"
                      [class.label-danger]="effectiveState(r).tone === 'danger'"
                      >{{ effectiveState(r).label }}</span
                    >
                    <div class="state-detail">{{ effectiveState(r).detail }}</div>
                  </td>
                  <td><span class="label" [class.label-success]="workloadPhase(r) === 'Ready'" [class.label-danger]="workloadPhase(r) === 'Degraded' || workloadPhase(r) === 'NotReady'">{{ workloadPhase(r) }}</span></td>
                  <td><span class="label" [class.label-success]="menuState(r).visible" [class.label-warning]="!menuState(r).visible">{{ menuState(r).label }}</span><div class="state-detail">{{ menuState(r).reason }}</div></td>
                  <td>{{ integrationSummary(r) }}</td>
                  <td><span class="label" [class.label-success]="r.status.channelState === 'Current'" [class.label-danger]="r.status.channelState === 'SecurityActionRequired'">{{ r.status.currentRequestedChannel || 'exact' }} · {{ r.status.channelState || '—' }}</span></td>
                  <td>
                    <button class="btn btn-sm btn-link" (click)="select(r.name)">Details</button>
                    @if (r.status.phase === 'Activated') {
                      <button class="btn btn-sm" (click)="run('disable', r.name)">Disable</button>
                    } @else {
                      <button
                        class="btn btn-sm btn-success-outline"
                        (click)="run('enable', r.name)"
                      >
                        Enable
                      </button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="7" class="os-sub">설치된 Extension 없음 — Catalog 탭에서 설치</td>
                </tr>
              }
            </tbody>
          </table>
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink>Catalog</button>
        <clr-tab-content>
          <table class="table">
            <thead>
              <tr>
                <th class="left">Package</th>
                <th>Version</th>
                <th>Owner</th>
                <th>State</th>
                <th>Permissions</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (c of catalog(); track c.name) {
                <tr>
                  <td class="left">
                    {{ c.displayName }} <span class="os-mono">({{ c.name }})</span>
                  </td>
                  <td>{{ c.version }}</td>
                  <td>{{ c.owner }}</td>
                  <td>
                    @if (phaseOf(c.name); as ph) {
                      <span
                        class="label"
                        [class.label-success]="ph === 'Activated' || ph === 'Ready'"
                        [class.label-danger]="ph === 'Failed'"
                        >{{ ph }}</span
                      >
                    } @else {
                      <span class="os-sub">미설치</span>
                    }
                  </td>
                  <td>{{ c.permissions?.join(', ') }}</td>
                  <td>
                    @switch (phaseOf(c.name)) {
                      @case ('Enabled') {
                        <button class="btn btn-sm" (click)="run('disable', c.name)">Disable</button>
                      }
                      @case ('Activated') {
                        <button class="btn btn-sm" (click)="run('disable', c.name)">Disable</button>
                      }
                      @case ('Ready') {
                        <button class="btn btn-sm btn-success-outline" [disabled]="foundationActivationLocked(c.name)" [title]="foundationActivationLocked(c.name) ? 'Platform Support Profile Ready 필요' : ''" (click)="run('enable', c.name)">Activate</button>
                      }
                      @case ('Disabled') {
                        <button
                          class="btn btn-sm btn-success-outline"
                          (click)="run('enable', c.name)"
                        >
                          Enable
                        </button>
                      }
                      @case ('Failed') {
                        <button class="btn btn-sm" (click)="run('disable', c.name)">Disable</button>
                      }
                      @default {
                        <button class="btn btn-sm btn-primary" (click)="run('install', c.name)">
                          Install
                        </button>
                      }
                    }
                    @if (phaseOf(c.name)) {
                      <!-- 삭제는 Catalog 탭에서만, 그리고 Disabled일 때만 활성(안전한 2단계 삭제 §6) -->
                      <button
                        class="btn btn-sm btn-danger-outline"
                        [disabled]="phaseOf(c.name) !== 'Disabled'"
                        [title]="
                          phaseOf(c.name) !== 'Disabled'
                            ? '먼저 Disable해야 삭제할 수 있습니다'
                            : ''
                        "
                        (click)="run('uninstall', c.name)"
                      >
                        Uninstall
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink>Audit</button>
        <clr-tab-content>
          <table class="table">
            <thead>
              <tr>
                <th class="left">Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              @for (e of events(); track $index) {
                <tr>
                  <td class="left os-mono">{{ e.time }}</td>
                  <td>{{ e.actor }}</td>
                  <td>{{ e.action }}</td>
                  <td>{{ e.target }}</td>
                  <td>{{ e.result }}{{ e.reason ? ' · ' + e.reason : '' }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="5" class="os-sub">감사 이벤트 없음</td>
                </tr>
              }
            </tbody>
          </table>
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink>Bindings</button>
        <clr-tab-content>
          <p class="os-sub">
            향후 workforce 인증·권한·명령처럼 Main Shell core 밖의 CLI 확장을 선언하는 채널입니다.
            native <code>os</code>는 이 목록에 포함되지 않습니다.
          </p>
          <table class="table">
            <thead>
              <tr>
                <th class="left">Binding</th>
                <th>Kind</th>
                <th>State</th>
                <th>Downloads</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (b of bindings(); track b.name) {
                <tr>
                  <td class="left">
                    {{ b.displayName }} <span class="os-mono">({{ b.name }})</span>
                    <div class="os-sub">{{ b.description }}</div>
                  </td>
                  <td><span class="label label-info">{{ b.kind }}</span></td>
                  <td>
                    <span class="label" [class.label-success]="b.enabled !== false">{{
                      b.enabled !== false ? 'Enabled' : 'Disabled'
                    }}</span>
                  </td>
                  <td>
                    @for (l of b.links; track l.href) {
                      <a class="btn btn-sm btn-link" [href]="l.href" target="_blank">{{ l.text }}</a>
                    }
                  </td>
                  <td>
                    @if (b.enabled !== false) {
                      <button class="btn btn-sm" (click)="runBinding('disable', b.name)">Disable</button>
                    } @else {
                      <button
                        class="btn btn-sm btn-success-outline"
                        (click)="runBinding('enable', b.name)"
                      >
                        Enable
                      </button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="5" class="os-sub">바인딩 없음</td>
                </tr>
              }
            </tbody>
          </table>
        </clr-tab-content>
      </clr-tab>
    </clr-tabs>

    <!-- 우측 슬라이드 상세 패널 — 선택 플러그인의 정확한 설치/검증 상태 -->
    @if (selectedReg(); as r) {
      <os-panel
        [open]="true"
        [title]="selectedPanelTitle()"
        [subtitle]="selectedPanelSubtitle()"
        (closed)="closePanel()"
      >

        <div class="cc-state cc-state-{{ effectiveState(r).tone }}">
          <span class="cc-dot"></span>
          <div>
            <strong>{{ effectiveState(r).label }}</strong>
            <p>{{ effectiveState(r).detail }}</p>
          </div>
          <span class="cc-desired">목표: {{ r.desiredState }}</span>
        </div>

        @if (!menuState(r).visible) {
          <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text"><strong>메뉴 미노출</strong> — {{ menuState(r).reason }}. Extension은 실행 중일 수 있지만 전역 메뉴에는 표시되지 않습니다.</span></clr-alert-item>
          </clr-alert>
        }

        <div class="cc-primary-actions">
          @if (pageReady(r)) {
            <a class="btn btn-sm btn-primary" [routerLink]="['/p', r.name]">Extension 페이지 열기</a>
          }
          <button class="btn btn-sm btn-outline" (click)="refresh()">상태 새로고침</button>
        </div>

        @if (r.status.phase === 'Failed' && r.status.reason) {
          <div class="cc-reason">
            <strong>사유</strong>
            <div>{{ reasonText(r.status.reason) }} <span class="os-mono">({{ r.status.reason }})</span></div>
          </div>
        }

        <div class="cc-layers" aria-label="Extension 상태 계층">
          @for (layer of statusLayers(r); track layer.label) {
            <div class="cc-layer cc-layer-{{ layer.tone }}">
              <span class="cc-layer-label">{{ layer.label }}</span>
              <strong>{{ layer.value }}</strong>
              <span>{{ layer.detail }}</span>
            </div>
          }
        </div>

        <section class="cc-integrations" aria-labelledby="cc-integrations-title">
          <div class="cc-section-head">
            <div><h3 id="cc-integrations-title">Console 연동 상태</h3><p>메뉴·페이지·API·검색·문서·관측 신호를 각각 확인합니다.</p></div>
            <span class="label">{{ integrationSummary(r) }}</span>
          </div>
          <table class="table table-compact">
            <thead><tr><th class="left">기능</th><th>상태</th><th class="left">근거</th><th>버전</th></tr></thead>
            <tbody>
              @for (item of integrationRows(r); track item.key) {
                <tr>
                  <td class="left"><strong>{{ item.label }}</strong><div class="os-mono">{{ item.key }}</div></td>
                  <td><span class="label" [class.label-success]="item.status.phase === 'Ready'" [class.label-warning]="item.status.phase === 'Disabled' || item.status.phase === 'DependencyPending'" [class.label-danger]="item.status.phase === 'Failed' || item.status.phase === 'Degraded'">{{ integrationPhaseLabel(item.status.phase) }}</span></td>
                  <td class="left">{{ item.status.reason || item.status.message || '연동 준비 완료' }}</td>
                  <td class="os-mono">{{ item.status.observedVersion || '—' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="4" class="left os-sub">연동 상태가 아직 보고되지 않았습니다. 컨트롤러 상태를 새로고침하세요.</td></tr>
              }
            </tbody>
          </table>
        </section>

        <clr-accordion class="cc-secondary">
          <clr-accordion-panel>
            <clr-accordion-title>배포·승인 상세</clr-accordion-title>
            <clr-accordion-description>{{ r.status.currentVersion || r.status.observedVersion || '버전 미보고' }}</clr-accordion-description>
            <clr-accordion-content *clrIfExpanded>
              <div class="cc-steps">
                <div class="cc-steps-h">Artifact 검증 단계</div>
                @for (s of steps(); track s.label) {
                  <div class="cc-step cc-step-{{ s.state }}">
                    <span class="cc-step-ic">{{ s.state === 'done' ? '✓' : s.state === 'fail' ? '✗' : s.state === 'active' ? '⋯' : '○' }}</span>
                    <span>{{ s.label }}</span>
                  </div>
                }
              </div>
              <dl class="cc-kv">
                <dt>등록 phase</dt><dd>{{ r.status.phase || '—' }}</dd>
                <dt>워크로드</dt><dd>{{ workloadPhase(r) }}</dd>
                <dt>사유</dt><dd>{{ r.status.reason || '—' }}</dd>
                <dt>마지막 변경</dt><dd class="os-mono">{{ r.status.lastTransitionTime || '—' }}</dd>
                <dt>manifest</dt><dd class="os-mono cc-break">{{ r.status.manifestUrl || '—' }}</dd>
                <dt>요청자</dt><dd>{{ r.approval?.requestedBy || '—' }}</dd>
                <dt>승인 사유</dt><dd>{{ r.approval?.reason || '—' }}</dd>
              </dl>
            </clr-accordion-content>
          </clr-accordion-panel>

          <clr-accordion-panel>
            <clr-accordion-title>메뉴 아이콘</clr-accordion-title>
            <clr-accordion-description>{{ iconToken() || '기본 아이콘' }}</clr-accordion-description>
            <clr-accordion-content *clrIfExpanded>
              <div class="cc-iconpick">
                <input class="cc-iconsearch" type="search" placeholder="Carbon 아이콘 검색…"
                       [value]="iconQuery()" (input)="iconQuery.set($any($event.target).value)" />
                <div class="cc-iconpick-note">
                  {{ iconLib.list().length ? (iconMatchCount() + '개 일치' + (iconMatchCount() > iconList().length ? (' · 상위 ' + iconList().length + '개 표시') : '')) : '라이브러리 로딩 중…' }}
                </div>
                <div class="cc-iconpick-grid">
                  <button type="button" class="cc-iconbtn" [class.sel]="!iconToken()" title="기본(자동)" (click)="chooseIcon('')">∅</button>
                  @for (c of iconList(); track c.token) {
                    <button type="button" class="cc-iconbtn" [class.sel]="iconToken() === c.token" [title]="c.label" (click)="chooseIcon(c.token)">
                      <os-rawicon [svg]="c.svg" [size]="24" />
                    </button>
                  }
                </div>
              </div>
            </clr-accordion-content>
          </clr-accordion-panel>
        </clr-accordion>

        <div class="cc-actions" aria-label="Extension lifecycle actions">
          @if (r.status.phase === 'Activated') {
            <button class="btn btn-sm" (click)="run('disable', r.name)">Disable</button>
          } @else {
            <button class="btn btn-sm btn-success-outline" (click)="run('enable', r.name)">Enable (재검증)</button>
          }
          <button class="btn btn-sm btn-danger-outline" (click)="run('uninstall', r.name)">Uninstall</button>
        </div>

        @if (r.status.phase === 'Failed') {
          <p class="os-sub">서명 검증 실패 시 nav에 노출되지 않습니다(보안 게이트). 유효 서명으로 재배포 후 Enable(재검증)하세요.</p>
        }
      </os-panel>
    }

    <os-action-dialog
      [open]="!!pendingUninstall()"
      title="Extension 제거"
      [message]="pendingUninstall() ? pendingUninstall() + '의 메뉴와 워크로드를 제거합니다.' : ''"
      confirmLabel="제거"
      [danger]="true"
      (confirmed)="confirmUninstall()"
      (cancelled)="pendingUninstall.set(null)"
    />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub {
        color: var(--os-muted);
        font-size: 0.7rem;
        margin: 0.3rem 0 0.8rem;
      }
      .os-engine {
        font-size: 0.6rem;
        color: var(--os-muted);
        font-weight: 400;
        margin-left: 0.4rem;
      }
      .os-mono {
        font-family: monospace;
        font-size: 0.62rem;
      }
      .management-actions {
        display: block;
        margin: 0 0 0.8rem;
      }
      .management-actions .registry-access:first-child { margin-top: 0.7rem; }
      .oci-install {
        padding: 0.8rem 1rem;
        margin-bottom: 1rem;
        border: 1px solid var(--os-hairline);
        border-radius: var(--os-radius);
        background: var(--os-surface-1);
      }
      .registry-access {
        padding: 0.8rem 1rem;
        margin-bottom: 1rem;
        border: 1px solid var(--os-hairline);
        border-radius: var(--os-radius);
        background: var(--os-surface-1);
      }
      .registry-access-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
      .registry-access h2 { margin: 0; font-size: 1rem; }
      .registry-access-form { display: flex; align-items: flex-end; gap: 0.55rem; flex-wrap: wrap; }
      .registry-access-form .clr-form-control { margin-top: 0.45rem; }
      .oci-install h2 { margin: 0; font-size: 1rem; }
      .oci-install .clr-form-control { margin-top: 0.45rem; }
      .inspection-plan { display: flex; align-items: center; gap: 0.45rem; margin-top: 0.65rem; flex-wrap: wrap; }
      .table .left {
        text-align: left;
      }
      .extension-link {
        border: 0;
        background: transparent;
        color: var(--os-link, #0065ab);
        font: inherit;
        font-weight: 600;
        padding: 0;
        cursor: pointer;
      }
      .extension-link:hover { text-decoration: underline; }
      .state-detail {
        max-width: 16rem;
        margin-top: 0.22rem;
        color: var(--os-muted);
        font-size: 0.64rem;
        line-height: 1.35;
      }
      .status-guide {
        display: flex;
        align-items: center;
        gap: 0.9rem;
        margin: 0.6rem 0;
        color: var(--os-muted);
        font-size: 0.68rem;
      }
      .status-guide strong { color: var(--os-ink); }
      .status-guide span { display: inline-flex; align-items: center; gap: 0.25rem; }
      .status-dot { width: 0.42rem; height: 0.42rem; border-radius: 50%; display: inline-block; }
      .status-dot.success { background: var(--os-success); }
      .status-dot.warning { background: var(--os-warning); }
      .status-dot.danger { background: var(--os-error); }
      .tree {
        font-size: 0.8rem;
        margin: 0.2rem 0 0.5rem;
      }
      .tn {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.25rem 0.2rem;
        border-bottom: 1px solid var(--clr-color-neutral-200, #eee);
      }
      .tn1 {
        padding-left: 1.6rem;
      }
      .tn2 {
        padding-left: 3.4rem;
      }
      .tn.host {
        background: var(--clr-color-neutral-100, #f6f7f9);
        font-size: 0.85rem;
      }
      .tn.empty {
        color: var(--os-muted);
        font-style: italic;
        border-bottom: 0;
      }
      .caret {
        border: 0;
        background: transparent;
        cursor: pointer;
        width: 1rem;
        padding: 0;
        color: var(--os-muted);
      }
      .caret-sp {
        width: 1rem;
        display: inline-block;
      }
      .tt {
        font-size: 0.56rem;
        font-weight: 700;
        padding: 0.05rem 0.35rem;
        border-radius: 3px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: #fff;
        white-space: nowrap;
      }
      .tt-mainShell {
        background: #1b2a4a;
      }
      .tt-subShell {
        background: #0d6e6e;
      }
      .tt-plugin {
        background: #3b5bdb;
      }
      .tt-core {
        background: #7048e8;
      }
      .tt-binding {
        background: #e8590c;
      }
      .tt-group {
        background: #868e96;
      }
      .tl {
        font-weight: 600;
      }
      .tm {
        color: var(--os-muted);
        font-family: monospace;
        font-size: 0.62rem;
        margin-left: auto;
      }
      .tc {
        color: var(--os-muted);
        font-size: 0.62rem;
        min-width: 1.2rem;
        text-align: right;
      }
      .tree .label {
        font-size: 0.56rem;
      }
      .cc-sel { cursor: pointer; }
      .cc-sel:hover { text-decoration: underline; }

      .cc-state {
        display: flex; align-items: center; gap: 0.5rem; margin: 0.9rem 0; padding: 0.55rem 0.75rem;
        border-radius: var(--os-radius); background: var(--os-surface-1); font-size: 0.9rem; color: var(--os-ink);
      }
      .cc-state p { margin: 0.12rem 0 0; color: var(--os-muted); font-size: 0.7rem; line-height: 1.35; }
      .cc-state .cc-desired { margin-left: auto; font-size: 0.72rem; color: var(--os-ink-muted); }
      .cc-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--os-ink-subtle); flex: 0 0 auto; }
      .cc-state-success .cc-dot { background: var(--os-success); }
      .cc-state-danger .cc-dot { background: var(--os-error); }
      .cc-state-warning .cc-dot { background: var(--os-warning); }
      .cc-state-danger { background: rgba(218, 30, 40, 0.08); }
      .cc-state-warning { background: rgba(255, 183, 0, 0.09); }
      .cc-reason { margin: 0 0 0.9rem; padding: 0.6rem 0.75rem; border-left: 3px solid var(--os-error); background: rgba(218, 30, 40, 0.06); font-size: 0.82rem; }
      .cc-reason strong { display: block; color: var(--os-error); margin-bottom: 0.15rem; }
      .cc-kv { display: grid; grid-template-columns: 6rem 1fr; gap: 0.35rem 0.6rem; margin: 0.6rem 0 1rem; font-size: 0.8rem; }
      .cc-kv dt { color: var(--os-ink-muted); }
      .cc-kv dd { margin: 0; color: var(--os-ink); }
      .cc-break { word-break: break-all; }
      .cc-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.8rem; }
      .cc-primary-actions { display: flex; gap: 0.4rem; margin: 0.5rem 0 0.9rem; }

      .cc-layers {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 0.45rem;
        margin: 0.7rem 0 1rem;
      }
      .cc-layer {
        display: flex;
        flex-direction: column;
        min-height: 5.2rem;
        padding: 0.55rem 0.6rem;
        border: 1px solid var(--os-hairline);
        border-top-width: 3px;
        background: var(--os-surface-1);
      }
      .cc-layer-success { border-top-color: var(--os-success); }
      .cc-layer-warning { border-top-color: var(--os-warning); }
      .cc-layer-danger { border-top-color: var(--os-error); }
      .cc-layer-neutral { border-top-color: var(--os-ink-subtle); }
      .cc-layer-label { color: var(--os-muted); font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em; }
      .cc-layer strong { margin: 0.18rem 0; font-size: 0.78rem; }
      .cc-layer > span:last-child { color: var(--os-muted); font-size: 0.62rem; line-height: 1.35; }

      .cc-integrations { margin: 0 0 1rem; }
      .cc-section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 0.8rem; }
      .cc-section-head h3 { margin: 0; font-size: 0.9rem; }
      .cc-section-head p { margin: 0.18rem 0 0.4rem; color: var(--os-muted); font-size: 0.68rem; }
      .cc-integrations .table { margin-top: 0.2rem; }
      .cc-secondary { display: block; margin-bottom: 0.8rem; }

      .cc-iconpick { margin: 0 0 1rem; }
      .cc-iconpick-h { font-size: 0.7rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--os-ink-muted); margin-bottom: 0.4rem; }
      .cc-iconpick-h .os-mono { text-transform: none; color: var(--os-ink); }
      .cc-iconsearch { width: 100%; padding: 0.4rem 0.5rem; margin-bottom: 0.35rem; border: 1px solid var(--os-hairline); border-radius: var(--os-radius); font-size: 0.8rem; }
      .cc-iconpick-note { font-size: 0.68rem; color: var(--os-ink-subtle); margin-bottom: 0.45rem; }
      .cc-iconpick-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.35rem; max-height: 17rem; overflow-y: auto; padding-right: 0.15rem; }
      .cc-iconbtn {
        display: flex; align-items: center; justify-content: center; height: 2.9rem; border: 1px solid var(--os-hairline);
        background: #fff; border-radius: var(--os-radius); cursor: pointer; color: var(--os-ink-muted); padding: 0; font-size: 1.1rem;
      }
      .cc-iconbtn:hover { border-color: var(--os-accent); color: var(--os-ink); }
      .cc-iconbtn.sel { border-color: var(--os-accent); box-shadow: inset 0 0 0 1px var(--os-accent); color: var(--os-accent); }

      .cc-steps { margin: 0.2rem 0 1rem; }
      .cc-steps-h { font-size: 0.7rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--os-ink-muted); margin-bottom: 0.4rem; }
      .cc-step { display: flex; align-items: center; gap: 0.5rem; padding: 0.28rem 0; font-size: 0.82rem; color: var(--os-ink-muted); }
      .cc-step-ic { width: 1.1rem; text-align: center; flex: 0 0 auto; font-weight: 700; }
      .cc-step-done { color: var(--os-ink); }
      .cc-step-done .cc-step-ic { color: var(--os-success); }
      .cc-step-fail { color: var(--os-error); font-weight: 600; }
      .cc-step-fail .cc-step-ic { color: var(--os-error); }
      .cc-step-active .cc-step-ic { color: var(--os-accent); }
      .cc-step-pending { opacity: 0.6; }
      @media (max-width: 1100px) {
        .cc-layers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .status-guide { align-items: flex-start; flex-direction: column; gap: 0.25rem; }
      }
    `,
  ],
})
export class AdminPlugins implements OnInit {
  private ctl = inject(PluginControlClient);
  private ext = inject(ExtensionHostService);
  private readinessApi = inject(PlatformReadinessService);
  readonly iconLib = inject(IconLibraryService);

  readonly catalog = signal<CatalogItem[]>([]);
  readonly registrations = signal<Registration[]>([]);
  readonly events = signal<AuditEvent[]>([]);
  readonly bindings = signal<Binding[]>([]);
  readonly inspection = signal<ExtensionInspection | null>(null);
  readonly registryStatus = signal<RegistryCredentialStatus | null>(null);
  readonly revocations = signal<ImageRevocation[]>([]);
  readonly foundationActivationAllowed = signal(false);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  readonly pendingUninstall = signal<string | null>(null);
  readonly expandedSet = signal<Set<string>>(new Set(['console', 'bindings']));
  readonly tree = computed<TreeNode[]>(() => this.buildTree());

  /** 우측 슬라이드 상세 패널 — 선택 플러그인의 정확한 상태(phase/reason 등). */
  readonly selected = signal<string | null>(null);
  readonly selectedReg = computed<Registration | null>(() => {
    const n = this.selected();
    return n ? (this.registrations().find((r) => r.name === n) ?? null) : null;
  });
  select(name: string): void { this.selected.set(name); this.iconLib.ensure(); }
  closePanel(): void { this.selected.set(null); }

  // ── 1단 아이콘 선택(IBM Carbon **전체 라이브러리**) — 기본값 + 사용자 선택. spec.nav.icon 패치 → registry → 셸 반영. ──
  readonly iconQuery = signal('');
  private readonly ICON_CAP = 300; // 한 번에 렌더할 최대 개수(2600+ 전체 DOM 방지) — 검색으로 좁힘.
  /** 검색어 일치 전체 개수(표시용). */
  readonly iconMatchCount = computed(() => this.iconFiltered().length);
  private iconFiltered() {
    const q = this.iconQuery().trim().toLowerCase();
    const src = this.iconLib.list(); // 전체 라이브러리(metadata)
    return q ? src.filter((c) => c.search.includes(q)) : src;
  }
  readonly iconList = computed(() => this.iconFiltered().slice(0, this.ICON_CAP));
  iconToken(): string {
    const n = this.selected();
    return this.catalog().find((c) => c.name === n)?.nav?.icon || '';
  }
  async chooseIcon(token: string): Promise<void> {
    const n = this.selected();
    if (!n) return;
    try {
      await this.ctl.setIcon(n, token);
      await this.refresh();    // catalog 갱신(현재 선택 표시)
      await this.ext.reload(); // registry 재로딩 → 1단 아이콘 즉시 갱신
      this.msg.set({ type: 'success', text: `아이콘 변경: ${token || '(기본)'}` });
    } catch (e) {
      this.msg.set({ type: 'danger', text: String(e) });
    }
  }
  selectedLabel(): string {
    const n = this.selected();
    return this.catalog().find((c) => c.name === n)?.displayName || n || '';
  }
  selectedPanelTitle(): string {
    return `${this.selectedLabel()} — Extension 상세`;
  }
  selectedPanelSubtitle(): string {
    const n = this.selected();
    const item = n ? this.catalogItem(n) : undefined;
    const registration = n ? this.registrations().find((r) => r.name === n) : undefined;
    const version = registration?.status.currentVersion || registration?.status.observedVersion || item?.version;
    return [item?.kind || 'Extension', n, version ? `v${version}` : ''].filter(Boolean).join(' · ');
  }
  displayName(name: string): string {
    return this.catalog().find((c) => c.name === name)?.displayName || name;
  }
  private catalogItem(name: string): CatalogItem | undefined {
    return this.catalog().find((c) => c.name === name);
  }
  integrationRows(r: Registration): IntegrationRow[] {
    const labels: Record<string, string> = {
      page: '페이지', navigation: '내부 메뉴 트리', api: 'API Proxy', cli: 'CLI', manual: 'Manual',
      search: '통합 검색', notification: '알림', logs: '로그', metrics: '메트릭', traces: '트레이스',
    };
    const order = Object.keys(labels);
    return Object.entries(r.status.integrations || {})
      .map(([key, status]) => ({ key, label: labels[key] || key, status }))
      .sort((a, b) => (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)));
  }
  integrationPhaseLabel(phase?: string): string {
    const labels: Record<string, string> = {
      Ready: 'Ready', Disabled: '미제공', Failed: '실패', Degraded: '저하', DependencyPending: '의존성 대기',
    };
    return labels[phase || ''] || phase || '미보고';
  }
  integrationSummary(r: Registration): string {
    const rows = this.integrationRows(r);
    if (!rows.length) return '상태 미보고';
    const ready = rows.filter((x) => x.status.phase === 'Ready').length;
    const issues = rows.filter((x) => ['Failed', 'Degraded', 'DependencyPending'].includes(x.status.phase)).length;
    const disabled = rows.filter((x) => x.status.phase === 'Disabled').length;
    return `${ready} Ready · ${disabled} 미제공${issues ? ` · ${issues} 확인 필요` : ''}`;
  }
  workloadPhase(r: Registration): string {
    return r.status.workload?.phase || r.health || '미보고';
  }
  menuState(r: Registration): { visible: boolean; label: string; reason: string } {
    const loadedPage = this.ext.pages().find((page) => page.id === r.name);
    if (loadedPage) return { visible: true, label: '메뉴 노출', reason: `${loadedPage.navBand} · /p/${r.name}` };
    const failure = this.ext.failures().find((item) => item.id === r.name);
    if (failure) return { visible: false, label: 'Host 적재 실패', reason: failure.error };
    if (this.ext.loadState() === 'loading') return { visible: false, label: 'Host 적재 중', reason: 'Extension Host가 검증·등록하는 중' };
    if (r.status.phase !== 'Activated') return { visible: false, label: '메뉴 미노출', reason: `Registration ${r.status.phase || '미보고'} 상태` };
    if (!this.catalogItem(r.name)?.nav) return { visible: false, label: '메뉴 미선언', reason: 'UIPluginPackage spec.nav가 없음' };
    return { visible: false, label: '메뉴 미노출', reason: 'Activated이지만 Extension Host pages registry에 적재되지 않음' };
  }
  pageReady(r: Registration): boolean {
    return r.status.integrations?.['page']?.phase === 'Ready';
  }
  effectiveStateByName(name: string): EffectiveExtensionState {
    const r = this.registrations().find((item) => item.name === name);
    return r ? this.effectiveState(r) : { label: '미설치', detail: 'Registration 없음', tone: 'neutral' };
  }
  effectiveState(r: Registration): EffectiveExtensionState {
    const phase = r.status.phase || 'Unknown';
    const rows = this.integrationRows(r);
    const failed = rows.filter((x) => ['Failed', 'Degraded'].includes(x.status.phase));
    if (phase === 'Failed' || failed.length) {
      return { label: phase === 'Failed' ? '실패' : '연동 저하', detail: r.status.reason || failed.map((x) => x.label).join(', '), tone: 'danger' };
    }
    if (phase === 'Disabled') return { label: '비활성', detail: '워크로드는 유지되지만 Console에서 비활성화됨', tone: 'neutral' };
    if (!['Activated', 'Ready'].includes(phase)) {
      return { label: phase, detail: r.status.reason || '설치·검증 진행 상태', tone: phase === 'Degraded' ? 'danger' : 'warning' };
    }
    const menu = this.menuState(r);
    const isSubShell = this.catalogItem(r.name)?.kind === 'subShell';
    if (isSubShell && !menu.visible) {
      return { label: `${phase} · 메뉴 미노출`, detail: menu.reason, tone: 'warning' };
    }
    const pending = rows.filter((x) => x.status.phase === 'DependencyPending');
    if (pending.length) return { label: `${phase} · 연동 대기`, detail: pending.map((x) => x.label).join(', '), tone: 'warning' };
    return { label: phase === 'Activated' ? 'Activated · 연동 완료' : 'Ready · 활성화 대기', detail: this.integrationSummary(r), tone: phase === 'Activated' ? 'success' : 'warning' };
  }
  statusLayers(r: Registration): StatusLayer[] {
    const verification = r.status.verification;
    const verificationValues = verification ? Object.values(verification) : [];
    const verified = verificationValues.length > 0 && verificationValues.every((v) => v === 'Verified' || v === 'Approved');
    const workload = this.workloadPhase(r);
    const menu = this.menuState(r);
    const integrationIssue = this.integrationRows(r).some((x) => ['Failed', 'Degraded', 'DependencyPending'].includes(x.status.phase));
    return [
      { label: '1. Artifact', value: verified ? 'Verified' : verificationValues.length ? '확인 필요' : '미보고', detail: 'manifest · signature · digest · permission', tone: verified ? 'success' : 'warning' },
      { label: '2. Workload', value: workload, detail: 'Pod · Service · health', tone: workload === 'Ready' ? 'success' : workload === 'Degraded' || workload === 'NotReady' ? 'danger' : 'warning' },
      { label: '3. Registration', value: r.status.phase || '미보고', detail: r.status.reason || 'DUPA lifecycle', tone: r.status.phase === 'Activated' || r.status.phase === 'Ready' ? 'success' : r.status.phase === 'Failed' ? 'danger' : 'warning' },
      { label: '4. Console integration', value: integrationIssue ? '확인 필요' : this.integrationSummary(r), detail: 'page · API · manual · search · observability', tone: integrationIssue ? 'danger' : 'success' },
      { label: '5. User visibility', value: menu.label, detail: menu.reason, tone: menu.visible ? 'success' : 'warning' },
    ];
  }
  /** 검증 실패 사유(reason) 한글 설명. */
  reasonText(reason?: string): string {
    const m: Record<string, string> = {
      SignatureInvalid: '서명이 신뢰키로 검증되지 않음',
      UntrustedKey: '신뢰하지 않는 서명 키(keyId)',
      DigestMismatch: 'manifest 해시(sha256) 불일치',
      EntryDigestMismatch: '엔트리(plugin.js) 해시 불일치',
      ShellCompatDrift: 'shellCompat 범위 불일치',
      ManifestUnreachable: 'manifest 접근 불가(파드/서비스)',
      EntryUnreachable: '엔트리 파일 접근 불가',
      SignatureUnreachable: '서명 파일 접근 불가',
      PermissionProfileDrift: 'DUPA가 요구하는 고정 RBAC 권한 프로파일과 설치된 ClusterRole 규칙이 다름',
    };
    return reason ? (m[reason] ?? reason) : '';
  }

  /** DUPA 설치/검증 파이프라인 단계(controller verifyPlugin 순서). reason으로 실패 지점 도출. */
  private readonly VSTEPS: { label: string; fail?: string[] }[] = [
    { label: '워크로드 기동 (Pod Running)' },
    { label: 'manifest 도달', fail: ['ManifestUnreachable'] },
    { label: 'manifest 해시(sha256) 검증', fail: ['DigestMismatch'] },
    { label: '서명 키 신뢰 (keyId)', fail: ['UntrustedKey'] },
    { label: '서명 검증 (P-256)', fail: ['SignatureInvalid'] },
    { label: 'shellCompat 호환', fail: ['ShellCompatDrift'] },
    { label: '엔트리(plugin.js) 해시', fail: ['EntryUnreachable', 'EntryDigestMismatch'] },
    { label: 'Console 레지스트리 등록' },
  ];
  steps(): { label: string; state: 'done' | 'fail' | 'pending' | 'active' }[] {
    const r = this.selectedReg();
    if (!r) return [];
    const phase = r.status.phase;
    const reason = r.status.reason;
    if (phase === 'Activated') return this.VSTEPS.map((s) => ({ label: s.label, state: 'done' }));
    if (phase === 'Ready') return this.VSTEPS.map((s, i) => ({ label: s.label, state: (i < this.VSTEPS.length - 1 ? 'done' : 'pending') as any }));
    if (phase === 'Disabled') return this.VSTEPS.map((s, i) => ({ label: s.label, state: (i < this.VSTEPS.length - 1 ? 'done' : 'pending') as any }));
    if (phase === 'Failed' && reason) {
      const fi = this.VSTEPS.findIndex((s) => s.fail?.includes(reason));
      return this.VSTEPS.map((s, i) => ({
        label: s.label,
        state: fi < 0 ? (i === 0 ? 'done' : 'pending') : i < fi ? 'done' : i === fi ? 'fail' : 'pending',
      }));
    }
    // Installing/기타 — 1단계 진행 중
    return this.VSTEPS.map((s, i) => ({ label: s.label, state: (i === 0 ? 'active' : 'pending') as any }));
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const [c, r, e, b, readiness, registry, revocations] = await Promise.all([
        this.ctl.catalog(),
        this.ctl.registrations(),
        this.ctl.events(),
        this.ctl.bindings(),
        this.readinessApi.status().catch(() => null),
        this.ctl.registryCredentialStatus().catch(() => null),
        this.ctl.revocations().catch(() => []),
      ]);
      this.catalog.set(c);
      this.registrations.set(r);
      this.events.set(e);
      this.bindings.set(b);
      this.foundationActivationAllowed.set(readiness?.admission.foundationActivationAllowed === true);
      this.registryStatus.set(registry);
      this.revocations.set(revocations);
    } catch (err) {
      this.msg.set({ type: 'danger', text: String(err) });
    }
  }

  async configureRegistryCredentials(username: string, token: string, reason: string): Promise<void> {
    try {
      this.registryStatus.set(await this.ctl.configureRegistryCredentials(username.trim(), token.trim(), reason.trim()));
      this.msg.set({ type: 'success', text: 'Private GHCR read credential이 저장되었습니다. 토큰 값은 다시 표시되지 않습니다.' });
    } catch (err) { this.msg.set({ type: 'danger', text: `GHCR 자격증명 저장 실패: ${err}` }); }
  }

  async removeRegistryCredentials(reason: string): Promise<void> {
    try {
      this.registryStatus.set(await this.ctl.removeRegistryCredentials(reason.trim()));
      this.msg.set({ type: 'success', text: 'Private GHCR read credential이 제거되었습니다.' });
    } catch (err) { this.msg.set({ type: 'danger', text: `GHCR 자격증명 제거 실패: ${err}` }); }
  }

  async revokeImage(image: string, replacementImage: string, reason: string): Promise<void> {
    try {
      await this.ctl.revokeImage(image.trim(), replacementImage.trim(), reason.trim());
      this.revocations.set(await this.ctl.revocations());
      this.msg.set({ type: 'success', text: 'Image digest가 철회되었고 신규 설치 및 활성 Registry 투영이 차단됩니다.' });
      await this.refresh();
    } catch (err) { this.msg.set({ type: 'danger', text: `Image 철회 실패: ${err}` }); }
  }

  foundationActivationLocked(id?: string | null): boolean {
    return id === 'foundation' && !this.foundationActivationAllowed();
  }

  async inspectImage(image: string): Promise<void> {
    this.inspection.set(null);
    try {
      const plan = await this.ctl.inspectImage(image.trim());
      this.inspection.set(plan);
      this.msg.set({ type: 'success', text: `검증 통과: ${plan.descriptor.id}` });
    } catch (err) { this.msg.set({ type: 'danger', text: `검증 실패: ${err}` }); }
  }

  async installImage(image: string, reason: string): Promise<void> {
    if (!this.inspection() || this.inspection()?.requestedImage !== image.trim()) return;
    try {
      const result = await this.ctl.installImage(image.trim(), reason.trim());
      this.msg.set({ type: 'info', text: `설치 요청됨: ${result.id} — 검증 완료 후 Ready 상태가 됩니다.` });
      await this.poll(result.id, 'install');
      await this.refresh();
    } catch (err) { this.msg.set({ type: 'danger', text: `설치 실패: ${err}` }); }
  }

  countPhase(p: string): number {
    return this.registrations().filter((r) => r.status.phase === p).length;
  }

  /** catalog 항목의 현재 설치 상태(Enabled/Disabled/Failed) — registration이 없으면 null(미설치).
   *  Catalog 탭이 이걸로 상태별 액션(Install/Enable/Disable/Uninstall)을 직접 노출한다. */
  phaseOf(name: string): string | null {
    return this.registrations().find((r) => r.name === name)?.status.phase ?? null;
  }

  // ── 구성도(Topology) 트리 — §2.7 shell→plugin 귀속 위계를 가용 신호(kind/hostRef·scope·core·nav)로 도출 ──
  /** kind/hostRef가 있으면 그대로, 없으면 scope·core·nav로 휴리스틱 분류(데이터 정확해지면 자동 정확화). */
  private classify(c: CatalogItem): 'core' | 'subShell' | 'plugin' {
    if (c.kind === 'subShell') return 'subShell';
    if (c.kind === 'plugin') return 'plugin';
    if (c.core || /admin|main-?shell|console-admin/i.test(c.scope || c.nav?.band || '')) return 'core';
    return c.nav?.band ? 'subShell' : 'plugin'; // nav 밴드 있는 비-core = perspective/subShell host
  }

  private buildTree(): TreeNode[] {
    const cat = this.catalog();
    const mk = (c: CatalogItem, type: TreeNode['type']): TreeNode => ({
      id: c.name,
      label: c.displayName || c.name,
      meta: c.name,
      type,
      phase: this.phaseOf(c.name),
      children: [],
      actionable: true,
    });
    const core = cat.filter((c) => this.classify(c) === 'core');
    const subs = cat.filter((c) => this.classify(c) === 'subShell');
    const plugins = cat.filter((c) => this.classify(c) === 'plugin');
    // subShell node: hostRef로 자기 plugin을 중첩(현재 hostRef 미존재 → 빈 host). 나머지 plugin은 mainShell 직속.
    const subNodes = subs.map((c) => {
      const n = mk(c, 'subShell');
      n.children = plugins.filter((p) => p.hostRef === c.name).map((p) => mk(p, 'plugin'));
      return n;
    });
    const mainPlugins = plugins.filter((p) => !p.hostRef || !subs.some((s) => s.name === p.hostRef));
    const consoleNode: TreeNode = {
      id: 'console',
      label: 'console',
      meta: 'mainShell · 루트 호스트',
      type: 'mainShell',
      actionable: false,
      children: [
        ...core.map((c) => mk(c, 'core')),
        ...subNodes,
        ...mainPlugins.map((c) => mk(c, 'plugin')),
      ],
    };
    const bindingsRoot: TreeNode = {
      id: 'bindings',
      label: 'Bindings',
      meta: 'workforce·외부 CLI 확장 · native os 제외',
      type: 'group',
      actionable: false,
      children: this.bindings().map((b) => ({
        id: b.name,
        label: b.displayName || b.name,
        meta: b.name,
        type: 'binding' as const,
        phase: b.enabled !== false ? 'Enabled' : 'Disabled',
        children: [],
        actionable: false,
      })),
    };
    return [consoleNode, bindingsRoot];
  }

  exp(id: string): boolean {
    return this.expandedSet().has(id);
  }
  toggle(id: string): void {
    const s = new Set(this.expandedSet());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.expandedSet.set(s);
  }
  typeLabel(t: TreeNode['type']): string {
    return t === 'group' ? '' : t;
  }

  async run(action: 'install' | 'enable' | 'disable' | 'uninstall', id: string): Promise<void> {
    if (action === 'uninstall') {
      this.pendingUninstall.set(id);
      return;
    }
    await this.execute(action, id);
  }

  async confirmUninstall(): Promise<void> {
    const id = this.pendingUninstall();
    if (!id) return;
    this.pendingUninstall.set(null);
    await this.execute('uninstall', id);
  }

  private async execute(action: 'install' | 'enable' | 'disable' | 'uninstall', id: string): Promise<void> {
    try {
      await this.ctl[action](id);
      this.msg.set({ type: 'info', text: `${action} 요청됨: ${id} — controller가 조정 중…` });
      // controller reconcile + registry 반영을 잠깐 기다린 뒤 셸 메뉴 reload
      await this.poll(id, action);
      await this.ext.reload();
      await this.refresh();
      this.msg.set({ type: 'success', text: `${action} 완료: ${id}` });
    } catch (err) {
      this.msg.set({ type: 'danger', text: `${action} 실패: ${err}` });
    }
  }

  /** binding 소프트 토글(enable/disable) — UI plugin과 별개 채널(binding≠plugin). 토글 후 목록 갱신. */
  async runBinding(action: 'enable' | 'disable', name: string): Promise<void> {
    try {
      await this.ctl.bindingAction(name, action);
      this.msg.set({ type: 'success', text: `binding ${action}: ${name}` });
      await this.refresh();
    } catch (err) {
      this.msg.set({ type: 'danger', text: `binding ${action} 실패: ${err}` });
    }
  }

  /** desired 상태에 도달할 때까지 짧게 폴링 (설치는 workload ready+검증까지 시간 필요) */
  private async poll(id: string, action: string): Promise<void> {
    const want = action === 'disable' ? 'Disabled' : action === 'install' ? 'Ready' : 'Activated';
    for (let i = 0; i < 40; i++) {
      const regs = await this.ctl.registrations();
      const r = regs.find((x) => x.name === id);
      // uninstall: CR이 삭제되면(목록에서 사라지면) 완료
      if (action === 'uninstall') {
        if (!r) {
          this.registrations.set(regs);
          return;
        }
      } else if (r?.status.phase === want || r?.status.phase === 'Failed') {
        this.registrations.set(regs);
        return;
      }
      await new Promise((f) => setTimeout(f, 1500));
    }
  }
}
