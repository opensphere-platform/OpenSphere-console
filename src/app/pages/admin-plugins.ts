import { Component, OnInit, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { OsPageHeader } from '../os/os-page-header';
import { OsRawIcon } from '../os/os-raw-icon';
import { OsPanel } from '../os/os-panel';
import { OsActionDialog } from '../os/os-action-dialog';
import { IconLibraryService } from '../os/icon-library.service';
import { ExtensionHostService } from '../core/extension-host.service';
import { PlatformReadinessService } from '../core/platform-readiness.service';
import { SystemPluginRegistryService } from '../core/system-plugin-registry.service';
import { buildExtensionManagementViews } from '../core/extension-view-model';
import {
  PluginControlClient,
  CatalogItem,
  Registration,
  AuditEvent,
  Binding,
  RegistryCredentialStatus,
  ImageRevocation,
  IntegrationStatus,
  ExtensionProjectionStatus,
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

/** 위계 트리 노드 — console(mainShell) → systemPlugin/subShell/plugin, + Bindings 분기. */
interface TreeNode {
  id: string;
  label: string;
  meta?: string;
  type: 'mainShell' | 'systemPlugin' | 'subShell' | 'plugin' | 'core' | 'binding' | 'group';
  phase?: string | null;
  children: TreeNode[];
  actionable: boolean;
}

type ExtensionManagementView = 'subshells' | 'plugins' | 'topology' | 'catalog' | 'audit' | 'bindings';
const EXTENSION_MANAGEMENT_VIEWS: readonly ExtensionManagementView[] = ['subshells', 'plugins', 'topology', 'catalog', 'audit', 'bindings'];

/**
 * Admin Control Page (계획서 §7) — Catalog/Installed/Audit 탭.
 * 설치/비활성화/재활성화/삭제를 Control API로만 수행하고, 성공 후 Extension Host를
 * reload하여 메뉴를 런타임 갱신한다. 셸 이미지·파드는 불변(DUPA 합격 기준).
 */
@Component({
  selector: 'os-admin-plugins',
  imports: [NgTemplateOutlet, RouterLink, ClarityModule, OsPageHeader, OsRawIcon, OsPanel, OsActionDialog],
  template: `
    <div class="os-page">
      <os-page-header title="Console Extensions" tag="Core Runtime">
        <p>Console 내장 system plugin과 subShell·plugin의 소유 관계, 현재 서비스, 서명 검증, 워크로드 연결을 한곳에서 관리합니다.</p>
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
    @if (dataWarning(); as warning) {
      <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
        <clr-alert-item><span class="alert-text">{{ warning }}</span></clr-alert-item>
      </clr-alert>
    }

    <section class="manage-status-rail" aria-label="Extension 운영 상태">
      <div><span>설치됨</span><strong>{{ registrationMetric('installed') }}</strong><small>Registration 보유</small></div>
      <div><span>서비스 중</span><strong class="ok">{{ registrationMetric('serving') }}</strong><small>메뉴와 페이지 사용 가능</small></div>
      <div><span>조치 필요</span><strong [class.danger]="failedCount() > 0">{{ registrationMetric('action') }}</strong><small>원인과 복구 절차 확인</small></div>
      <div><span>처리 중</span><strong>{{ registrationMetric('pending') }}</strong><small>설치·검증·의존성 대기</small></div>
      <div><span>사용자 비활성</span><strong class="neutral">{{ registrationMetric('disabled') }}</strong><small>명시적으로 중지됨</small></div>
      <div><span>상태 동기화</span><strong [class.warn]="projectionStatus()?.state === 'stale'">{{ projectionLabel() }}</strong><small>공유 Registry projection</small></div>
    </section>

    <clr-accordion class="management-actions">
      <clr-accordion-panel>
        <clr-accordion-title>관리 작업</clr-accordion-title>
        <clr-accordion-description>Extension 설치 · Registry 자격증명 · Digest 철회</clr-accordion-description>
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
      <div class="registry-access-form registry-access-form--credentials">
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
      <div class="registry-access-form registry-access-form--revocation">
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
      <h2 id="oci-install-title">Extension 설치</h2>
      <p class="os-sub">Console과 <code>os</code> CLI는 같은 lifecycle API, 서명·권한 검증과 감사 원장을 사용합니다. 개발용 local edge의 설치·업데이트는 MFA를 생략하고, 다른 환경과 다른 lifecycle 작업은 최근 MFA를 요구합니다. 사유는 항상 8자 이상 필요합니다.</p>
      <div class="registry-access-form registry-access-form--install">
        <div class="clr-form-control">
          <label for="extension-image" class="clr-control-label">OCI image</label>
          <div class="clr-control-container"><div class="clr-input-wrapper"><input
            id="extension-image"
            class="clr-input"
            placeholder="ghcr.io/opensphere-platform/opensphere-…:edge"
            [value]="extensionInstallImage()"
            (input)="extensionInstallImage.set($any($event.target).value)"
          /></div></div>
        </div>
        <div class="clr-form-control">
          <label for="extension-install-reason" class="clr-control-label">설치 사유</label>
          <div class="clr-control-container"><div class="clr-input-wrapper"><input
            id="extension-install-reason"
            class="clr-input"
            minlength="8"
            placeholder="운영 변경 사유(8자 이상)"
            [value]="extensionInstallReason()"
            (input)="extensionInstallReason.set($any($event.target).value)"
          /></div></div>
        </div>
        <button
          class="btn btn-primary"
          [disabled]="installing() || !extensionInstallImage().trim() || extensionInstallReason().trim().length < 8"
          (click)="installModule(extensionInstallImage(), extensionInstallReason())"
        >
          설치
        </button>
      </div>
    </section>
        </clr-accordion-content>
      </clr-accordion-panel>
    </clr-accordion>

    <ng-template #extensionStatusTable let-items let-emptyText="emptyText" let-showHost="showHost" let-showIcon="showIcon">
      <div class="extension-table-wrap">
        <table class="table extension-table" [class.extension-table--with-host]="showHost">
          <thead>
            <tr>
              <th class="left">Extension</th>
              @if (showHost) { <th class="left">소속 Host</th> }
              <th>사용자 설정</th>
              <th>현재 서비스</th>
              <th>실행 상태</th>
              <th>검증·업데이트</th>
              <th class="left">버전·채널</th>
              <th>Console 연결</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            @for (r of items; track r.name) {
              <tr>
                <td class="left">
                  <div class="extension-identity">
                    @if (showIcon) {
                      <span class="extension-identity-icon" [title]="extensionIconToken(r.name)">
                        <os-rawicon [svg]="extensionIconSvg(r.name)" [size]="20" />
                      </span>
                    }
                    <div>
                      <button type="button" class="extension-link" (click)="select(r.name)">{{ displayName(r.name) }}</button>
                      <div class="state-detail">{{ extensionKind(r) }} · <span class="os-mono">{{ r.name }}</span></div>
                    </div>
                  </div>
                </td>
                @if (showHost) {
                  <td class="left">
                    <strong>{{ extensionParentLabel(r) }}</strong>
                    <div class="state-detail os-mono">{{ extensionParentRef(r) }}</div>
                  </td>
                }
                <td>
                  <span class="label" [class.label-success]="r.desiredState === 'Enabled'" [class.label-warning]="r.desiredState === 'Installed'">{{ desiredStateLabel(r) }}</span>
                  <div class="state-detail">{{ desiredStateDetail(r) }}</div>
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
                <td>
                  <span class="label" [class.label-success]="workloadPhase(r) === 'Ready'" [class.label-danger]="workloadPhase(r) === 'Degraded' || workloadPhase(r) === 'NotReady'">{{ workloadPhase(r) }}</span>
                  <div class="state-detail">Pod · Service</div>
                </td>
                <td>
                  <span class="label" [class.label-success]="verificationGate(r).tone === 'success'" [class.label-warning]="verificationGate(r).tone === 'warning'" [class.label-danger]="verificationGate(r).tone === 'danger'">{{ verificationGate(r).label }}</span>
                  <div class="state-detail">{{ verificationGate(r).detail }}</div>
                </td>
                <td class="left">
                  <strong>{{ artifactVersion(r) }}</strong>
                  <div class="state-detail">{{ r.status.currentRequestedChannel || 'exact' }} · {{ buildAuthorityLabel(r.status.currentBuildAuthority) }}</div>
                  <div class="os-mono" [title]="r.status.currentDigest || 'digest 미보고'">{{ shortDigest(r.status.currentDigest) }}</div>
                </td>
                <td>
                  <span class="label" [class.label-success]="menuState(r).visible" [class.label-warning]="!menuState(r).visible">{{ menuState(r).label }}</span>
                  <div class="state-detail">{{ menuState(r).reason }}</div>
                  <div class="state-detail">{{ integrationSummary(r) }}</div>
                </td>
                <td class="extension-actions">
                  <button class="btn btn-sm btn-link" (click)="select(r.name)">Details</button>
                  @if (r.desiredState === 'Enabled') {
                    <button class="btn btn-sm" (click)="run('disable', r.name)">Disable</button>
                  } @else {
                    <button
                      class="btn btn-sm btn-success-outline"
                      [disabled]="activationLocked(r.name)"
                      [title]="activationLockReason(r.name) || ''"
                      (click)="run('enable', r.name)"
                    >
                      Enable
                    </button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="showHost ? 9 : 8" class="os-sub">{{ emptyText }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    </ng-template>

    <clr-tabs>
      <clr-tab>
        <button clrTabLink (click)="selectView('subshells')">SubShells <span class="view-count">{{ subShellRegistrations().length }}</span></button>
        <clr-tab-content *clrIfActive="activeView() === 'subshells'">
          <div class="extension-view-intro">
            <div><span class="view-kicker">FIRST-LEVEL OPERATING SHELLS</span><h2>SubShell 관리</h2></div>
            <p>Main Shell에 직접 연결되어 1단 메뉴와 독립 운영 영역을 제공하는 subShell만 표시합니다. plugin은 이 view에 포함하지 않습니다.</p>
          </div>
          <div class="status-guide">
            <strong>상태 읽는 법</strong>
            <span><i class="status-dot success"></i>사용자 설정대로 서비스 중</span>
            <span><i class="status-dot warning"></i>서비스 유지 또는 처리 대기</span>
            <span><i class="status-dot danger"></i>서비스 차단 — 운영자 조치 필요</span>
          </div>
          <ng-container *ngTemplateOutlet="extensionStatusTable; context: { $implicit: subShellRegistrations(), emptyText: '설치된 subShell이 없습니다.', showHost: false, showIcon: true }" />
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink (click)="selectView('plugins')">Plugins <span class="view-count">{{ pluginListCount() }}</span></button>
        <clr-tab-content *clrIfActive="activeView() === 'plugins'">
          <div class="extension-view-intro">
            <div><span class="view-kicker">SYSTEM &amp; HOSTED CAPABILITIES</span><h2>Plugin 관리</h2></div>
            <p>Console 내장 system plugin과 subShell이 소유·호스팅하는 Registry plugin을 권한 경계에 따라 분리해 표시합니다.</p>
          </div>
          <section class="plugin-host-group" aria-label="System Plugins">
            <header>
              <div><span class="view-kicker">CONSOLE-OWNED</span><h3>System Plugins</h3></div>
              <div class="plugin-host-coordinate"><span class="label label-info">system</span><code>cbss-main-shell</code><strong>{{ systemPluginDescriptors().length }} plugin</strong></div>
            </header>
            <div class="extension-table-wrap">
              <table class="table extension-table" aria-label="Console system plugin 목록">
                <thead>
                  <tr>
                    <th class="left">이름</th>
                    <th class="left">유형</th>
                    <th class="left">소유자</th>
                    <th class="left">Route</th>
                    <th class="left">Runtime adapter</th>
                    <th class="left">수명주기</th>
                  </tr>
                </thead>
                <tbody>
                  @for (descriptor of systemPluginDescriptors(); track descriptor.id) {
                    <tr>
                      <td><strong>{{ descriptor.id === 'os-shell' ? 'OS Shell' : descriptor.id }}</strong><div class="state-detail"><code>{{ descriptor.id }}</code></div></td>
                      <td><span class="label label-info">systemPlugin</span></td>
                      <td><code>{{ descriptor.owner }}</code></td>
                      <td><a [href]="descriptor.route"><code>{{ descriptor.route }}</code></a></td>
                      <td><code>{{ descriptor.runtimeAdapterId || '—' }}</code></td>
                      <td><span class="label label-success">Console 내장</span><div class="state-detail">Console exact digest에 결속된 읽기 전용 항목</div></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="6" class="os-sub">검증된 system plugin이 없습니다.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
          <div class="extension-view-intro"><div><span class="view-kicker">REGISTRY-MANAGED</span><h2>Registry Plugins</h2></div><p>{{ pluginRegistrationCount() }} plugin</p></div>
          <p class="os-sub">Registry plugin은 1단 메뉴 객체가 아닙니다. 각 plugin을 소유·호스팅하는 subShell 아래에서 설치·활성화·검증 상태를 관리합니다.</p>
          @for (group of pluginHostGroups(); track group.hostRef) {
            <section class="plugin-host-group" [attr.aria-label]="group.hostLabel + ' plugins'">
              <header>
                <div><span class="view-kicker">HOST</span><h3>{{ group.hostLabel }}</h3></div>
                <div class="plugin-host-coordinate"><span class="label label-info">subShell</span><code>{{ group.hostRef }}</code><strong>{{ group.items.length }} plugin</strong></div>
              </header>
              <ng-container *ngTemplateOutlet="extensionStatusTable; context: { $implicit: group.items, emptyText: '이 host에 설치된 plugin이 없습니다.', showHost: true, showIcon: false }" />
            </section>
          } @empty {
            <div class="empty-view">설치된 plugin이 없습니다. plugin은 설치 후 선언된 <code>hostRef</code> 아래에 표시됩니다.</div>
          }
          @if (unclassifiedRegistrations().length) {
            <section class="plugin-host-group contract-warning" aria-label="분류 확인 필요">
              <header><div><span class="view-kicker">CONTRACT WARNING</span><h3>분류 확인 필요</h3></div></header>
              <p>Catalog의 kind/hostRef 계약과 연결되지 않은 Registration입니다. subShell이나 plugin 목록에 임의 편입하지 않습니다.</p>
              <ng-container *ngTemplateOutlet="extensionStatusTable; context: { $implicit: unclassifiedRegistrations(), emptyText: '', showHost: true, showIcon: false }" />
            </section>
          }
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink (click)="selectView('topology')">구성도 Topology</button>
        <clr-tab-content *clrIfActive="activeView() === 'topology'">
          <p class="os-sub">
            Console 직할 system plugin과 Registry 기반 shell → plugin 귀속 위계 —
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
                    @if (c.children.length) {
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
                      @if (desiredStateByName(c.id) === 'Enabled') {
                        <button class="btn btn-sm" (click)="run('disable', c.id)">Disable</button>
                      } @else {
                        <button
                          class="btn btn-sm btn-success-outline"
                          [disabled]="activationLocked(c.id)"
                          [title]="activationLockReason(c.id) || ''"
                          (click)="run('enable', c.id)"
                        >
                          Enable
                        </button>
                      }
                    }
                    <span class="tm">{{ c.meta }}</span>
                  </div>
                  @if (exp(c.id) && c.children.length) {
                    @for (g of c.children; track g.id) {
                      <div class="tn tn2">
                        <span class="caret-sp"></span><span class="tt tt-{{ g.type }}" [class.tt-core]="g.type === 'systemPlugin'">{{ typeLabel(g.type) }}</span>
                        <span class="tl" [class.cc-sel]="g.actionable" (click)="g.actionable && select(g.id)">{{ g.label }}</span>
                        @if (g.phase) {
                          <span class="label"
                            [class.label-success]="effectiveStateByName(g.id).tone === 'success'"
                            [class.label-warning]="effectiveStateByName(g.id).tone === 'warning'"
                            [class.label-danger]="effectiveStateByName(g.id).tone === 'danger'">{{ effectiveStateByName(g.id).label }}</span>
                        }
                        <span class="tm">{{ g.meta }}</span>
                      </div>
                    } @empty {
                      @if (c.type === 'subShell') {
                        <div class="tn tn2 empty">
                          모듈 없음 — 이 shell에 귀속된 plugin 미배포 (Phase 2 예정)
                        </div>
                      }
                    }
                  }
                }
              }
            }
          </div>
          <p class="os-sub">
            System Plugins는 Console exact digest에 결속된 검증된 내장 descriptor를 투영합니다.
            동적 확장은 Registry의 <code>kind</code>·<code>hostRef</code>와 동일 ID
            Package·Registration 계약만 투영하며, 계약을 충족하지 못한 항목은 추론하지 않습니다.
          </p>
        </clr-tab-content>
      </clr-tab>

      <clr-tab>
        <button clrTabLink (click)="selectView('catalog')">Catalog</button>
        <clr-tab-content *clrIfActive="activeView() === 'catalog'">
          <table class="table">
            <thead>
              <tr>
                <th class="left">Package</th>
                <th>호환 버전</th>
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
                  <td>{{ compatibilityValue(c.version) }}</td>
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
                        <button class="btn btn-sm btn-success-outline" [disabled]="activationLocked(c.name)" [title]="activationLockReason(c.name) || ''" (click)="run('enable', c.name)">Activate</button>
                      }
                      @case ('Disabled') {
                        <button
                          class="btn btn-sm btn-success-outline"
                          [disabled]="activationLocked(c.name)"
                          [title]="activationLockReason(c.name) || ''"
                          (click)="run('enable', c.name)"
                        >
                          Enable
                        </button>
                      }
                      @case ('Failed') {
                        <button class="btn btn-sm" (click)="run('disable', c.name)">Disable</button>
                      }
                      @default {
                        <span class="os-sub">위 “Extension 설치”에서 OCI release 지정</span>
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
        <button clrTabLink (click)="selectView('audit')">Audit</button>
        <clr-tab-content *clrIfActive="activeView() === 'audit'">
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
        <button clrTabLink (click)="selectView('bindings')">Bindings</button>
        <clr-tab-content *clrIfActive="activeView() === 'bindings'">
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
          <span class="cc-desired">사용자 설정: {{ desiredStateLabel(r) }}</span>
        </div>

        @if (!menuState(r).visible) {
          <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text"><strong>페이지 서비스 차단</strong> — {{ menuState(r).reason }}. 사용자 설정은 {{ desiredStateLabel(r) }} 상태로 유지됩니다.</span></clr-alert-item>
          </clr-alert>
        }

        <div class="cc-primary-actions">
          @if (pageReady(r)) {
            <a class="btn btn-sm btn-primary" [routerLink]="extensionPageRoute(r)">Extension 페이지 열기</a>
          }
          <button class="btn btn-sm btn-outline" (click)="refresh()">상태 새로고침</button>
        </div>

        @if (r.status.phase === 'Failed' && r.status.reason) {
          <div class="cc-reason">
            <strong>현재 원인</strong>
            <div>{{ reasonText(r.status.reason) }} <span class="os-mono">({{ r.status.reason }})</span></div>
            <p>{{ remediationText(r.status.reason) }}</p>
          </div>
        }

        @if (r.status.admission && !r.status.admission.activationAllowed) {
          <div class="cc-admission">
            <strong>활성화 대기 — Platform Support Profile {{ satisfiedCount(r) }}/{{ totalCount(r) }} 충족</strong>
            <p>설치와 검증은 끝났습니다. 아래 capability가 준비되면 활성화할 수 있습니다.</p>
            <ul class="cc-admission-list">
              @for (capability of r.status.admission.pendingCapabilities || []; track capability) {
                <li><span class="label label-warning">필요</span> {{ capabilityText(capability) }}</li>
              }
              @for (capability of r.status.admission.satisfiedCapabilities || []; track capability) {
                <li><span class="label label-success">충족</span> {{ capabilityText(capability) }}</li>
              }
            </ul>
            <a class="btn btn-sm btn-primary" [href]="r.status.admission.route || '/manage/platform-control'">Platform Support Profile 열기</a>
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
            <thead><tr><th class="left">기능</th><th>상태</th><th class="left">근거</th><th>호환 버전</th></tr></thead>
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
            <clr-accordion-title>Artifact · 설치 근거</clr-accordion-title>
            <clr-accordion-description>{{ extensionKind(r) }} · {{ artifactVersion(r) }} · {{ installationActor(r) }}</clr-accordion-description>
            <clr-accordion-content *clrIfExpanded>
              <dl class="cc-kv">
                <dt>종류</dt><dd>{{ extensionKind(r) }}</dd>
                <dt>공식 버전</dt><dd>{{ artifactVersion(r) }}</dd>
                <dt>호환 버전</dt><dd>{{ compatibilityVersion(r) }}</dd>
                <dt>빌드 권위</dt><dd>{{ buildAuthorityLabel(r.status.currentBuildAuthority) }}</dd>
                <dt>불변 digest</dt><dd class="os-mono cc-break">{{ r.status.currentDigest || '—' }}</dd>
                <dt>요청 ref · 채널</dt><dd class="os-mono cc-break">{{ r.status.currentRequestedRef || '—' }} · {{ r.status.currentRequestedChannel || 'exact' }}</dd>
                <dt>Artifact 해석</dt><dd class="os-mono">{{ r.status.currentResolvedAt || '—' }}</dd>
                <dt>Source · revision</dt><dd class="os-mono cc-break">{{ r.status.currentSource || '—' }} · {{ r.status.currentRevision || '—' }}</dd>
                <dt>설치 시각</dt><dd class="os-mono">{{ installationTime(r) }}</dd>
                <dt>설치자</dt><dd>{{ installationActor(r) }} <span class="os-mono">{{ r.installation?.requestedById || '' }}</span></dd>
                <dt>설치 경로</dt><dd>{{ r.installation?.client || 'legacy registration' }}</dd>
                <dt>작업 ID</dt><dd class="os-mono cc-break">{{ r.installation?.operationId || '—' }}</dd>
              </dl>
            </clr-accordion-content>
          </clr-accordion-panel>

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
          @if (r.desiredState === 'Enabled') {
            @if (r.status.phase === 'Failed') {
              <button class="btn btn-sm btn-primary" (click)="run('enable', r.name)">검증 다시 시도</button>
            }
            <button class="btn btn-sm" (click)="run('disable', r.name)">Disable</button>
          } @else {
            <button
              class="btn btn-sm btn-success-outline"
              [disabled]="activationLocked(r.name)"
              [title]="activationLockReason(r.name) || ''"
              (click)="run('enable', r.name)"
            >
              Enable
            </button>
          }
          <button
            class="btn btn-sm btn-outline"
            [disabled]="!rollbackAvailable(r)"
            [title]="rollbackAvailable(r) ? rollbackSummary(r) : '검증된 이전 release 증거가 없습니다.'"
            (click)="run('rollback', r.name)"
          >
            Rollback
          </button>
          <button class="btn btn-sm btn-danger-outline" (click)="run('uninstall', r.name)">Uninstall</button>
        </div>

        @if (r.status.phase === 'Failed') {
          <p class="os-sub">검증을 우회하지 않습니다. 신뢰키·digest·서명 원인을 복구한 뒤 “검증 다시 시도”를 실행하면 기존 Enabled 설정으로 자동 수렴합니다.</p>
        }
      </os-panel>
    }

    <os-action-dialog
      [open]="!!pendingAction()"
      [title]="pendingAction()?.action === 'uninstall' ? 'Extension 제거' : 'Extension 상태 변경'"
      [message]="pendingAction() ? pendingAction()!.id + '에 ' + pendingAction()!.action + ' 작업을 실행합니다.' : ''"
      [confirmLabel]="pendingAction()?.action === 'uninstall' ? '제거' : '실행'"
      [danger]="pendingAction()?.action === 'uninstall'"
      [reasonRequired]="true"
      (confirmed)="confirmAction($event)"
      (cancelled)="pendingAction.set(null)"
    />
    <os-action-dialog
      [open]="!!pendingRollback()"
      title="이전 검증 Release로 롤백"
      [message]="pendingRollbackRegistration() ? rollbackSummary(pendingRollbackRegistration()!) : ''"
      confirmLabel="검증 후 롤백"
      [reasonRequired]="true"
      reasonLabel="롤백 승인 사유"
      (confirmed)="confirmRollback($event)"
      (cancelled)="pendingRollback.set(null)"
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
      .registry-access-form { display: flex; align-items: flex-end; gap: 0.7rem; flex-wrap: wrap; }
      .registry-access-form .clr-form-control { min-width: 0; margin-top: 0.45rem; }
      .registry-access-form .clr-control-container,
      .registry-access-form .clr-input-wrapper,
      .registry-access-form .clr-input { box-sizing: border-box; width: 100%; max-width: none; }
      .registry-access-form--credentials .clr-form-control:nth-child(1) { flex: 0.8 1 16rem; }
      .registry-access-form--credentials .clr-form-control:nth-child(2) { flex: 1.15 1 22rem; }
      .registry-access-form--credentials .clr-form-control:nth-child(3) { flex: 1.35 1 26rem; }
      .registry-access-form--revocation .clr-form-control:nth-child(1) { flex: 1.5 1 34rem; }
      .registry-access-form--revocation .clr-form-control:nth-child(2) { flex: 1.25 1 30rem; }
      .registry-access-form--revocation .clr-form-control:nth-child(3) { flex: 1 1 22rem; }
      .registry-access-form--install .clr-form-control:nth-child(1) { flex: 1.5 1 36rem; }
      .registry-access-form--install .clr-form-control:nth-child(2) { flex: 1 1 28rem; }
      .registry-access-form > .btn { flex: 0 0 auto; }
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
      .extension-identity { display: flex; align-items: flex-start; gap: 0.55rem; min-width: 0; }
      .extension-identity-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 1.5rem;
        width: 1.5rem;
        height: 1.5rem;
        color: var(--os-ink);
      }
      .state-detail {
        max-width: none;
        margin-top: 0.22rem;
        color: var(--os-muted);
        font-size: 0.64rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .status-guide {
        display: flex;
        align-items: center;
        gap: 0.9rem;
        min-height: 2.6rem;
        margin: 0.6rem 0 0;
        padding: 0.45rem 0.7rem;
        border: 1px solid var(--os-hairline);
        border-bottom: 0;
        background: var(--os-surface-1);
        color: var(--os-muted);
        font-size: 0.68rem;
        flex-wrap: wrap;
      }
      .status-guide strong { color: var(--os-ink); }
      .status-guide span { display: inline-flex; align-items: center; gap: 0.25rem; }
      .view-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.2rem;
        margin-left: 0.3rem;
        padding: 0 0.3rem;
        border-radius: 0.65rem;
        background: var(--clr-color-neutral-200, #e8e8e8);
        font-size: 0.62rem;
        line-height: 1.2rem;
      }
      .extension-view-intro {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        margin: 0.9rem 0 0;
        padding-bottom: 0.55rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .extension-view-intro h2,
      .plugin-host-group h3 { margin: 0.15rem 0 0; }
      .extension-view-intro p { max-width: 52rem; margin: 0; color: var(--os-muted); font-size: 0.72rem; }
      .view-kicker { color: var(--os-accent); font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; }
      .plugin-host-group {
        margin: 0.9rem 0 1rem;
        border: 1px solid var(--os-hairline);
        overflow: hidden;
      }
      .plugin-host-group > header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.7rem 0.9rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .plugin-host-group>header{color:#fff}
      .plugin-host-group>header *{color:inherit!important}
      .plugin-host-group .extension-table-wrap { padding: 0.65rem; }
      .plugin-host-coordinate { display: flex; align-items: center; gap: 0.45rem; color: var(--os-muted); font-size: 0.68rem; }
      .plugin-host-coordinate code { color: var(--os-ink); }
      .empty-view { margin: 0.8rem 0; padding: 1rem; border: 1px dashed var(--os-hairline); color: var(--os-muted); }
      .contract-warning { border-color: var(--os-warning); }
      .contract-warning > p { margin: 0.6rem 0.9rem; color: var(--os-muted); font-size: 0.7rem; }
      .extension-table-wrap {
        width: 100%;
        overflow-x: auto;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas, #fff);
      }
      .plugin-host-group .extension-table-wrap { border: 0; background: transparent; }
      .extension-table {
        width: 100%;
        min-width: 82rem;
        margin: 0 !important;
        border: 0 !important;
        table-layout: fixed;
      }
      .extension-table.extension-table--with-host { min-width: 86rem; }
      .extension-table th,
      .extension-table td {
        min-width: 0;
        padding: 0.7rem 0.8rem !important;
        text-align: left !important;
      }
      .extension-table th {
        white-space: nowrap;
        font-size: 0.7rem;
      }
      .extension-table td { vertical-align: top; overflow-wrap: anywhere; }
      .extension-table:not(.extension-table--with-host) th:nth-child(1) { width: 20%; }
      .extension-table:not(.extension-table--with-host) th:nth-child(2) { width: 12%; }
      .extension-table:not(.extension-table--with-host) th:nth-child(3) { width: 12%; }
      .extension-table:not(.extension-table--with-host) th:nth-child(4) { width: 9%; }
      .extension-table:not(.extension-table--with-host) th:nth-child(5) { width: 11%; }
      .extension-table:not(.extension-table--with-host) th:nth-child(6) { width: 15%; }
      .extension-table:not(.extension-table--with-host) th:nth-child(7) { width: 12%; }
      .extension-table:not(.extension-table--with-host) th:nth-child(8) { width: 9%; }
      .extension-table--with-host th:nth-child(1) { width: 16%; }
      .extension-table--with-host th:nth-child(2) { width: 14%; }
      .extension-table--with-host th:nth-child(3) { width: 11%; }
      .extension-table--with-host th:nth-child(4) { width: 10%; }
      .extension-table--with-host th:nth-child(5) { width: 8%; }
      .extension-table--with-host th:nth-child(6) { width: 9%; }
      .extension-table--with-host th:nth-child(7) { width: 12%; }
      .extension-table--with-host th:nth-child(8) { width: 10%; }
      .extension-table--with-host th:nth-child(9) { width: 10%; }
      .extension-actions { white-space: nowrap; }
      .extension-actions .btn + .btn { margin-left: 0.25rem; }
      .extension-table .os-mono { overflow-wrap: anywhere; }
      clr-tab-content > .table:not(.extension-table) {
        margin-top: 0.75rem;
        table-layout: fixed;
      }
      .tree {
        overflow: hidden;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas, #fff);
      }
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
      .cc-reason p { margin: 0.35rem 0 0; color: var(--os-ink-muted); line-height: 1.45; }
      .cc-admission { margin: 0 0 0.9rem; padding: 0.6rem 0.75rem; border-left: 3px solid var(--os-warning); background: rgba(240, 171, 0, 0.08); font-size: 0.82rem; }
      .cc-admission strong { display: block; margin-bottom: 0.15rem; }
      .cc-admission p { margin: 0 0 0.4rem; color: var(--os-text-sec); }
      .cc-admission-list { list-style: none; margin: 0 0 0.5rem; padding: 0; display: grid; gap: 0.2rem; }
      .cc-admission-list li { display: flex; align-items: center; gap: 0.4rem; }
      .cc-kv { display: grid; grid-template-columns: 6rem 1fr; gap: 0.35rem 0.6rem; margin: 0.6rem 0 1rem; font-size: 0.8rem; }
      .cc-kv dt { color: var(--os-ink-muted); }
      .cc-kv dd { margin: 0; color: var(--os-ink); }
      .cc-break { word-break: break-all; }
      .cc-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.8rem; }
      .cc-primary-actions { display: flex; gap: 0.4rem; margin: 0.5rem 0 0.9rem; }

      .cc-layers {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
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
  private systemPlugins = inject(SystemPluginRegistryService);
  private readinessApi = inject(PlatformReadinessService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly iconLib = inject(IconLibraryService);
  readonly activeView = signal<ExtensionManagementView>(this.normalizeView(this.route.snapshot.paramMap.get('view')));

  readonly catalog = signal<CatalogItem[]>([]);
  readonly registrations = signal<Registration[]>([]);
  readonly events = signal<AuditEvent[]>([]);
  readonly bindings = signal<Binding[]>([]);
  readonly registryStatus = signal<RegistryCredentialStatus | null>(null);
  readonly revocations = signal<ImageRevocation[]>([]);
  readonly installing = signal(false);
  readonly pendingRollback = signal<string | null>(null);
  readonly foundationActivationAllowed = signal(false);
  readonly catalogLoaded = signal(false);
  readonly registrationsLoaded = signal(false);
  readonly bindingsLoaded = signal(false);
  readonly projectionStatus = signal<ExtensionProjectionStatus | null>(null);
  readonly dataWarning = signal<string | null>(null);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  readonly extensionInstallImage = signal('');
  readonly extensionInstallReason = signal('');
  readonly pendingAction = signal<{ action: 'enable' | 'disable' | 'uninstall'; id: string } | null>(null);
  readonly expandedSet = signal<Set<string>>(new Set(['console', 'system-plugins', 'bindings']));
  readonly tree = computed<TreeNode[]>(() => this.buildTree());
  readonly extensionViews = computed(() => buildExtensionManagementViews(this.catalog(), this.registrations()));
  readonly subShellRegistrations = computed(() => this.extensionViews().subShells);
  readonly pluginHostGroups = computed(() => this.extensionViews().pluginGroups);
  readonly unclassifiedRegistrations = computed(() => this.extensionViews().unclassified);
  readonly pluginRegistrationCount = computed(() =>
    this.pluginHostGroups().reduce((total, group) => total + group.items.length, 0),
  );
  readonly systemPluginDescriptors = computed(() => this.systemPlugins.list());
  readonly pluginListCount = computed(() => this.pluginRegistrationCount() + this.systemPluginDescriptors().length);

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
  extensionIconToken(name: string): string {
    return this.catalog().find((c) => c.name === name)?.nav?.icon || 'application';
  }
  extensionIconSvg(name: string): string {
    return this.iconLib.getSvg(this.extensionIconToken(name)) || '';
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
    const reportedArtifactVersion = registration?.status.currentVersion || registration?.status.observedVersion;
    const versionLabel = reportedArtifactVersion && registration
      ? `공식 ${this.artifactVersion(registration)}`
      : item?.version ? `호환 ${this.compatibilityValue(item.version)}` : '';
    return [item?.kind || 'Extension', n, versionLabel].filter(Boolean).join(' · ');
  }
  displayName(name: string): string {
    return this.catalog().find((c) => c.name === name)?.displayName || name;
  }
  extensionKind(r: Registration): string {
    return this.catalogItem(r.name)?.kind || 'Extension';
  }
  extensionParentRef(r: Registration): string {
    const item = this.catalogItem(r.name);
    return item?.kind === 'plugin' ? (item.hostRef || 'main') : 'main';
  }
  extensionParentLabel(r: Registration): string {
    const parentRef = this.extensionParentRef(r);
    return parentRef === 'main' ? 'OpenSphere Main Shell' : this.displayName(parentRef);
  }
  artifactVersion(r: Registration): string {
    const version = r.status.currentVersion || r.status.observedVersion || '';
    return !version ? '—' : /^[0-9]{12}$/.test(version) ? version : `규칙 위반 · ${version}`;
  }
  compatibilityVersion(r: Registration): string {
    const version = r.status.currentCompatibilityVersion || this.catalogItem(r.name)?.version || '';
    return this.compatibilityValue(version);
  }
  compatibilityValue(version?: string): string {
    return !version ? '—' : /^\d+\.\d+\.\d+$/.test(version) ? version : `규칙 위반 · ${version}`;
  }
  buildAuthorityLabel(authority?: string): string {
    if (authority === 'localhost') return 'Local Windows/amd64';
    if (authority === 'github-actions') return 'GitHub Actions';
    return '—';
  }
  installationTime(r: Registration): string {
    return r.installation?.requestedAt || '기록 없음';
  }
  installationActor(r: Registration): string {
    return r.installation?.requestedBy || r.approval?.requestedBy || '기록 없음';
  }
  desiredStateLabel(r: Registration): string {
    const labels: Record<string, string> = {
      Enabled: '활성 유지',
      Installed: '설치됨 · 미활성',
      Disabled: '사용자 비활성',
      Uninstalled: '제거 요청',
    };
    return labels[r.desiredState] || r.desiredState || '미보고';
  }
  desiredStateDetail(r: Registration): string {
    if (r.desiredState === 'Enabled') return '명시적 비활성 요청 없음';
    if (r.desiredState === 'Disabled') return '운영자가 메뉴·페이지를 중지함';
    if (r.desiredState === 'Installed') return '검증 후 활성화 대기';
    return r.approval?.reason || '설정 기록 확인 필요';
  }
  shortDigest(digest?: string): string {
    return /^sha256:[a-f0-9]{64}$/.test(digest || '') ? `${digest!.slice(0, 19)}…${digest!.slice(-12)}` : 'digest 미보고';
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
    if (r.status.phase === 'Failed') return '상위 검증 게이트 대기';
    const ready = rows.filter((x) => x.status.phase === 'Ready').length;
    const issues = rows.filter((x) => ['Failed', 'Degraded', 'DependencyPending'].includes(x.status.phase)).length;
    const disabled = rows.filter((x) => x.status.phase === 'Disabled').length;
    return `${ready} Ready · ${disabled} 미제공${issues ? ` · ${issues} 확인 필요` : ''}`;
  }
  workloadPhase(r: Registration): string {
    return r.status.workload?.phase || r.health || '미보고';
  }
  menuState(r: Registration): { visible: boolean; label: string; reason: string } {
    const hostRef = this.catalogItem(r.name)?.hostRef || 'main';
    const loadedPage = this.ext.pages().find((page) => page.id === r.name);
    if (loadedPage) return { visible: true, label: '메뉴 노출', reason: `${loadedPage.navBand} · /p/${r.name}` };
    const failure = this.ext.failures().find((item) => item.id === r.name);
    if (failure) return { visible: false, label: 'Host 적재 실패', reason: failure.error };
    if (this.ext.loadState() === 'loading') return { visible: false, label: 'Host 적재 중', reason: 'Extension Host가 검증·등록하는 중' };
    if (r.status.phase === 'Failed') return { visible: false, label: '서비스 차단', reason: this.reasonText(r.status.reason) || '보안 검증 실패' };
    if (r.status.phase !== 'Activated') return { visible: false, label: '서비스 대기', reason: `Registration ${r.status.phase || '미보고'} 상태` };
    if (!this.catalogItem(r.name)?.nav) return { visible: false, label: '메뉴 미선언', reason: 'UIPluginPackage spec.nav가 없음' };
    if (hostRef !== 'main') {
      const childState = this.ext.pluginLoadState(r.name);
      if (childState === 'ready') {
        const projection = this.ext.hostChildProjection(hostRef, r.name);
        if (projection) {
          return { visible: true, label: 'Host 메뉴 사용 가능', reason: `${projection.route} · ${projection.element}` };
        }
        return {
          visible: false,
          label: 'Host 연동 실패',
          reason: `HostProjectionMissing — ${hostRef}가 ${this.extensionPageRoute(r)} 관리면을 승인하지 않았습니다. Host 업데이트가 필요합니다.`,
        };
      }
      if (childState === 'loading') {
        return { visible: false, label: 'Host 적재 중', reason: `${hostRef}가 child plugin을 검증·활성화하는 중` };
      }
      return { visible: false, label: 'Host 메뉴 미제공', reason: `${hostRef} child 활성화가 완료되지 않음` };
    }
    return { visible: false, label: '메뉴 미노출', reason: 'Activated이지만 Extension Host pages registry에 적재되지 않음' };
  }
  pageReady(r: Registration): boolean {
    return r.status.integrations?.['page']?.phase === 'Ready';
  }
  effectiveStateByName(name: string): EffectiveExtensionState {
    const r = this.registrations().find((item) => item.name === name);
    return r ? this.effectiveState(r) : { label: '미설치', detail: 'Registration 없음', tone: 'neutral' };
  }

  extensionPageRoute(r: Registration): string {
    const hostRef = this.catalogItem(r.name)?.hostRef || 'main';
    const projection = hostRef === 'main' ? undefined : this.ext.hostChildProjection(hostRef, r.name);
    if (projection) return projection.route;
    if (hostRef === 'foundation') return `/pfss/${r.name}`;
    return hostRef === 'main' ? `/p/${r.name}` : `/p/${hostRef}/${r.name}`;
  }
  desiredStateByName(name: string): string {
    return this.registrations().find((item) => item.name === name)?.desiredState || '';
  }
  effectiveState(r: Registration): EffectiveExtensionState {
    const phase = r.status.phase || 'Unknown';
    const rows = this.integrationRows(r);
    const failed = rows.filter((x) => ['Failed', 'Degraded'].includes(x.status.phase));
    if (r.desiredState === 'Disabled' || phase === 'Disabled') {
      return { label: '비활성', detail: '운영자가 Console 노출을 중지했습니다. 워크로드 보존 여부는 설치 정책을 따릅니다.', tone: 'neutral' };
    }
    if (r.status.serving?.phase === 'LastKnownGood') {
      return {
        label: '기존 검증본 서비스',
        detail: `일시적인 ${this.reasonText(r.status.revalidation?.reason || r.status.serving.reason) || '재검증 대기'} 동안 마지막 정상 버전을 유지합니다.`,
        tone: 'warning',
      };
    }
    if (phase === 'Failed' || failed.length) {
      return {
        label: phase === 'Failed' ? '서비스 차단' : '연동 저하',
        detail: phase === 'Failed' ? this.reasonText(r.status.reason) : failed.map((x) => x.label).join(', '),
        tone: 'danger',
      };
    }
    if (!['Activated', 'Ready'].includes(phase)) {
      return { label: phase, detail: r.status.reason || '설치·검증 진행 상태', tone: phase === 'Degraded' ? 'danger' : 'warning' };
    }
    if (phase === 'Ready' && this.activationLocked(r.name)) {
      return {
        label: 'Ready · 활성화 대기',
        detail: this.activationLockReason(r.name) || 'Platform Support Profile이 Ready가 되면 활성화할 수 있습니다.',
        tone: 'warning',
      };
    }
    const hostFailure = this.ext.failures().find((item) => item.id === r.name);
    if (hostFailure) {
      return {
        label: 'UI 적재 실패',
        detail: hostFailure.error,
        tone: 'danger',
      };
    }
    const menu = this.menuState(r);
    const isSubShell = this.catalogItem(r.name)?.kind === 'subShell';
    const isHostedPlugin = (this.catalogItem(r.name)?.hostRef || 'main') !== 'main';
    if (isHostedPlugin && !menu.visible) {
      if (this.ext.loadState() === 'loading' || this.ext.pluginLoadState(r.name) === 'loading') {
        return { label: 'Host 적재 중', detail: menu.reason, tone: 'warning' };
      }
      return { label: 'Host 연동 실패', detail: menu.reason, tone: 'danger' };
    }
    if (isSubShell && !menu.visible) {
      if (this.ext.loadState() === 'loading') {
        return { label: 'UI 적재 중', detail: menu.reason, tone: 'warning' };
      }
      return {
        label: 'UI 활성화 실패',
        detail: `서버에는 ${phase === 'Activated' ? '게시됐지만' : '준비됐지만'} 현재 브라우저 세션에서 페이지를 등록하지 못했습니다. ${menu.reason}`,
        tone: 'danger',
      };
    }
    const pending = rows.filter((x) => x.status.phase === 'DependencyPending');
    if (pending.length) return { label: `${phase} · 연동 대기`, detail: pending.map((x) => x.label).join(', '), tone: 'warning' };
    return { label: phase === 'Activated' ? '사용 가능' : '게시 대기', detail: this.integrationSummary(r), tone: phase === 'Activated' ? 'success' : 'warning' };
  }
  verificationGate(r: Registration): EffectiveExtensionState {
    if (r.status.serving?.phase === 'LastKnownGood') {
      return {
        label: '재검증 대기',
        detail: this.reasonText(r.status.revalidation?.reason || r.status.serving.reason) || '마지막 정상 버전 유지',
        tone: 'warning',
      };
    }
    if (r.status.phase === 'Failed') {
      return {
        label: '검증 차단',
        detail: this.reasonText(r.status.reason) || r.status.reason || '원인 확인 필요',
        tone: 'danger',
      };
    }
    const verification = Object.values(r.status.verification || {});
    const passed = verification.length > 0 && verification.every((value) => value === 'Verified' || value === 'Approved');
    if (passed) return { label: '검증 통과', detail: r.status.channelState || 'exact digest', tone: 'success' };
    return { label: '검증 중', detail: r.status.reason || r.status.phase || '상태 대기', tone: 'warning' };
  }
  statusLayers(r: Registration): StatusLayer[] {
    const verification = r.status.verification;
    const verificationValues = verification ? Object.values(verification) : [];
    const verified = verificationValues.length > 0 && verificationValues.every((v) => v === 'Verified' || v === 'Approved');
    const workload = this.workloadPhase(r);
    const menu = this.menuState(r);
    return [
      { label: '사용자 설정', value: this.desiredStateLabel(r), detail: this.desiredStateDetail(r), tone: r.desiredState === 'Enabled' ? 'success' : 'neutral' },
      { label: 'Artifact 검증', value: this.verificationGate(r).label, detail: this.verificationGate(r).detail, tone: this.verificationGate(r).tone },
      { label: '워크로드', value: workload, detail: '실제 Pod · Service readiness', tone: workload === 'Ready' ? 'success' : workload === 'Degraded' || workload === 'NotReady' ? 'danger' : 'warning' },
      { label: '페이지 서비스', value: menu.label, detail: menu.reason, tone: menu.visible ? 'success' : r.status.phase === 'Failed' ? 'danger' : 'warning' },
    ];
  }
  /** 검증 실패 사유(reason) 한글 설명. */
  reasonText(reason?: string): string {
    const m: Record<string, string> = {
      SignatureInvalid: '서명이 신뢰키로 검증되지 않음',
      UntrustedKey: '신뢰하지 않는 서명 키(keyId)',
      DigestMismatch: 'manifest 해시(sha256) 불일치',
      EntryDigestMismatch: '엔트리(plugin.js) 해시 불일치',
      NonClosedModuleArtifact: '브라우저 Blob 실행 계약을 위반한 분할 모듈(relative import/chunk)이 남아 있음',
      ShellCompatDrift: 'shellCompat 범위 불일치',
      ManifestUnreachable: 'manifest 접근 불가(파드/서비스)',
      EntryUnreachable: '엔트리 파일 접근 불가',
      SignatureUnreachable: '서명 파일 접근 불가',
    };
    return reason ? (m[reason] ?? reason) : '';
  }
  remediationText(reason?: string): string {
    const actions: Record<string, string> = {
      UntrustedKey: '개발 클러스터 trust store에 해당 공개키를 복구한 뒤 재검증합니다. 개인키나 검증 우회는 사용하지 않습니다.',
      SignatureInvalid: '게시된 descriptor와 서명키가 같은 release에서 생성됐는지 확인하고 새 immutable 버전으로 다시 게시합니다.',
      DigestMismatch: 'Package가 승인한 manifest digest와 workload가 제공하는 파일을 대조하고 새 digest로 다시 배포합니다.',
      EntryDigestMismatch: 'signed manifest의 entry hash와 실제 bundle을 일치시킨 뒤 새 버전으로 게시합니다.',
      ManifestUnreachable: 'Service와 Pod readiness를 확인합니다. 같은 검증본이면 메뉴는 마지막 정상 상태로 유지됩니다.',
      EntryUnreachable: 'Extension Service의 정적 파일 경로를 확인합니다. 같은 검증본이면 메뉴는 마지막 정상 상태로 유지됩니다.',
      WorkloadNotReady: 'Deployment event와 readiness probe를 확인한 뒤 자동 재시도를 기다립니다.',
    };
    return reason ? (actions[reason] || '상세 검증 단계와 Controller 이벤트를 확인한 뒤 원인을 복구하고 재검증합니다.') : '';
  }

  /** Platform Support Profile capability 이름을 운영자 문구로. 미지 값은 원문을 보존한다. */
  private readonly CAPABILITY_TEXT: Record<string, string> = {
    Delivery: 'Delivery — 선언형 배포 경로(GitOps)',
    Observability: 'Observability — 텔레메트리 수집·조회',
    BackupRestore: 'Backup/Restore — 백업과 복구 리허설 증거',
    SecurityPolicy: 'Security/Policy — 격리·admission·최소권한',
  };
  capabilityText(capability: string): string {
    return this.CAPABILITY_TEXT[capability] || capability;
  }
  satisfiedCount(r: Registration): number {
    return (r.status.admission?.satisfiedCapabilities || []).length;
  }
  totalCount(r: Registration): number {
    return this.satisfiedCount(r) + (r.status.admission?.pendingCapabilities || []).length;
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
    { label: '단일 ESM 산출물 계약', fail: ['NonClosedModuleArtifact'] },
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
    void this.iconLib.ensure();
    this.route.paramMap.subscribe((params) => {
      const requested = params.get('view');
      const normalized = this.normalizeView(requested);
      this.activeView.set(normalized);
      if (requested !== normalized) {
        void this.router.navigate(['/manage/extensions', normalized], { replaceUrl: true });
      }
    });
    await this.refresh();
  }

  selectView(view: ExtensionManagementView): void {
    if (this.activeView() === view) return;
    this.activeView.set(view);
    void this.router.navigate(['/manage/extensions', view]);
  }

  private normalizeView(value: string | null): ExtensionManagementView {
    return EXTENSION_MANAGEMENT_VIEWS.includes(value as ExtensionManagementView)
      ? value as ExtensionManagementView
      : 'subshells';
  }

  async refresh(): Promise<void> {
    const names = ['Catalog', 'Registration', '감사 이력', 'Binding', '플랫폼 준비 상태', 'Registry 자격증명', 'Digest 철회'];
    const results = await Promise.allSettled([
      this.ctl.catalogSnapshot(),
      this.ctl.registrationsSnapshot(),
      this.ctl.events(),
      this.ctl.bindings(),
      this.readinessApi.status(),
      this.ctl.registryCredentialStatus(),
      this.ctl.revocations(),
    ]);
    const issues: string[] = [];
    const [catalog, registrations, events, bindings, readiness, registry, revocations] = results;
    if (catalog.status === 'fulfilled') {
      this.catalog.set(catalog.value.items);
      this.catalogLoaded.set(true);
      this.projectionStatus.set(catalog.value.projection);
    } else issues.push(names[0]);
    if (registrations.status === 'fulfilled') {
      this.registrations.set(registrations.value.items);
      this.registrationsLoaded.set(true);
      this.projectionStatus.set(registrations.value.projection);
    } else issues.push(names[1]);
    if (events.status === 'fulfilled') this.events.set(events.value); else issues.push(names[2]);
    if (bindings.status === 'fulfilled') {
      this.bindings.set(bindings.value);
      this.bindingsLoaded.set(true);
    } else issues.push(names[3]);
    if (readiness.status === 'fulfilled') this.foundationActivationAllowed.set(readiness.value.admission.foundationActivationAllowed === true);
    else issues.push(names[4]);
    if (registry.status === 'fulfilled') this.registryStatus.set(registry.value); else issues.push(names[5]);
    if (revocations.status === 'fulfilled') this.revocations.set(revocations.value); else issues.push(names[6]);

    if (issues.length) {
      const retained = this.catalogLoaded() || this.registrationsLoaded();
      if (retained && (catalog.status === 'rejected' || registrations.status === 'rejected')) {
        const previous = this.projectionStatus();
        this.projectionStatus.set({ ...(previous || { ready: true }), state: 'stale', reason: 'ControlApiUnavailable' });
      }
      this.dataWarning.set(`${issues.join(', ')} 조회 실패 — ${retained ? '마지막 정상 값을 유지합니다.' : '유효한 상태 스냅샷이 아직 없습니다. 0건으로 간주하지 않습니다.'}`);
    } else if (this.projectionStatus()?.state === 'stale') {
      this.dataWarning.set(`공유 Extension 스냅샷이 오래되었습니다. 마지막 정상 값(${this.projectionStatus()?.observedAt || '시각 미보고'})을 표시합니다.`);
    } else {
      this.dataWarning.set(null);
    }
  }

  async configureRegistryCredentials(username: string, token: string, reason: string): Promise<void> {
    try {
      this.registryStatus.set(await this.ctl.configureRegistryCredentials(username.trim(), token.trim(), reason.trim()));
      this.msg.set({ type: 'success', text: 'Private GHCR read credential이 저장되었습니다. 토큰 값은 다시 표시되지 않습니다.' });
    } catch (err) { this.msg.set({ type: 'danger', text: `GHCR 자격증명 저장 실패: ${err}` }); }
  }

  async installExtension(image: string, reason: string): Promise<void> {
    if (this.installing()) return;
    this.installing.set(true);
    try {
      const result = await this.ctl.install(image.trim(), reason.trim());
      const waiting = result.activation?.allowed === false
        ? ` 활성화는 ${result.activation.pendingCapabilities.join(', ') || result.activation.reason} 충족까지 대기합니다.`
        : '';
      const operation = result.operation === 'Update' ? '업데이트' : '설치';
      const intent = result.desiredState === 'Enabled' ? '기존 활성 상태를 유지합니다.'
        : result.desiredState === 'Disabled' ? '기존 비활성 상태를 유지합니다.'
          : '검증 후 관리자가 활성화할 수 있습니다.';
      this.msg.set({ type: 'success', text: `${result.id} ${operation}가 접수되었습니다. ${intent}${waiting}` });
      await this.refresh();
    } catch (err) {
      this.msg.set({ type: 'danger', text: `Extension 설치 실패: ${err}` });
    } finally {
      this.installing.set(false);
    }
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
    return false;
  }

  /**
   * 활성화가 잠긴 이유 — 잠기지 않았으면 null.
   * Foundation subShell과, 설치는 됐지만 Platform Support Profile을 기다리는 PFS
   * plugin을 함께 다룬다. 후자는 controller가 registration status.admission에
   * 실어 보내므로 화면이 미충족 capability를 그대로 이름으로 말할 수 있다.
   */
  activationLockReason(id?: string | null): string | null {
    const admission = this.registrations().find((r) => r.name === id)?.status?.admission;
    if (!admission || admission.activationAllowed !== false) return null;
    const pending = (admission.pendingCapabilities || []).map((c) => this.capabilityText(c));
    return pending.length
      ? `Platform Support Profile 미충족 — ${pending.join(', ')}`
      : 'Platform Support Profile Ready가 필요합니다.';
  }
  activationLocked(id?: string | null): boolean {
    return this.activationLockReason(id) !== null;
  }

  catalogMetric(): string {
    return this.catalogLoaded() ? String(this.catalog().length) : '—';
  }

  failedCount(): number {
    return this.registrations().filter((registration) => this.effectiveState(registration).tone === 'danger').length;
  }

  registrationMetric(metric: 'installed' | 'serving' | 'action' | 'pending' | 'disabled'): string {
    if (!this.registrationsLoaded()) return '—';
    const registrations = this.registrations();
    if (metric === 'installed') return String(registrations.length);
    if (metric === 'serving') return String(registrations.filter((r) => r.desiredState === 'Enabled' && this.menuState(r).visible).length);
    if (metric === 'disabled') return String(registrations.filter((r) => r.status.phase === 'Disabled').length);
    if (metric === 'action') return String(this.failedCount());
    return String(registrations.filter((r) => !['Activated', 'Disabled', 'Failed'].includes(r.status.phase || '') && this.effectiveState(r).tone !== 'danger').length);
  }

  projectionLabel(): string {
    const state = this.projectionStatus()?.state;
    return state === 'live' ? 'Live' : state === 'stale' ? 'Stale' : '—';
  }
  countUsable(): number {
    return this.registrations().filter((r) => this.effectiveState(r).tone === 'success').length;
  }
  countWaiting(): number {
    return this.registrations().filter((r) => this.effectiveState(r).tone === 'warning').length;
  }
  countDisabled(): number {
    return this.registrations().filter((r) => r.desiredState === 'Disabled' || r.status.phase === 'Disabled').length;
  }
  countFailed(): number {
    return this.registrations().filter((r) => this.effectiveState(r).tone === 'danger').length;
  }

  /** catalog 항목의 현재 설치 상태(Enabled/Disabled/Failed) — registration이 없으면 null(미설치).
   *  Catalog 탭이 이걸로 상태별 액션(Install/Enable/Disable/Uninstall)을 직접 노출한다. */
  phaseOf(name: string): string | null {
    return this.registrations().find((r) => r.name === name)?.status.phase ?? null;
  }

  // ── 구성도(Topology) 트리 — Console system plugin + Registry kind/hostRef 투영 ──
  private buildTree(): TreeNode[] {
    const catalogByName = new Map(this.catalog().map((item) => [item.name, item]));
    const mk = (c: CatalogItem, type: TreeNode['type']): TreeNode => ({
      id: c.name,
      label: c.displayName || c.name,
      meta: c.name,
      type,
      phase: this.phaseOf(c.name),
      children: [],
      actionable: true,
    });
    const views = this.extensionViews();
    const pluginGroupsByHost = new Map(views.pluginGroups.map((group) => [group.hostRef, group]));
    const subNodes = views.subShells.flatMap((registration) => {
      const item = catalogByName.get(registration.name);
      if (!item) return [];
      const n = mk(item, 'subShell');
      n.children = (pluginGroupsByHost.get(item.name)?.items || []).flatMap((pluginRegistration) => {
        const plugin = catalogByName.get(pluginRegistration.name);
        return plugin ? [mk(plugin, 'plugin')] : [];
      });
      return n;
    });
    const mainPlugins = (pluginGroupsByHost.get('main')?.items || []).flatMap((registration) => {
      const item = catalogByName.get(registration.name);
      return item ? [mk(item, 'plugin')] : [];
    });
    const systemPluginRoot: TreeNode = {
      id: 'system-plugins',
      label: 'System Plugins',
      meta: 'Console exact-digest 내장 기능',
      type: 'group',
      actionable: false,
      children: this.systemPlugins.list().map((descriptor) => ({
        id: descriptor.id,
        label: descriptor.id === 'os-shell' ? 'OS Shell' : descriptor.id,
        meta: `${descriptor.route} · ${descriptor.owner} · Console release-bound`,
        type: 'systemPlugin',
        children: [],
        actionable: false,
      })),
    };
    const consoleNode: TreeNode = {
      id: 'console',
      label: 'console',
      meta: 'mainShell · 루트 호스트',
      type: 'mainShell',
      actionable: false,
      children: [
        systemPluginRoot,
        ...subNodes,
        ...mainPlugins,
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
    if (t === 'group') return '';
    return t === 'systemPlugin' ? 'system' : t;
  }

  rollbackAvailable(r: Registration): boolean {
    const previousDigest = String(r.status.previousDigest || '');
    const currentDigest = String(r.status.currentDigest || '');
    return /^sha256:[a-f0-9]{64}$/.test(previousDigest)
      && previousDigest !== currentDigest
      && /^[a-f0-9]{64}$/.test(String(r.status.previousManifestSha256 || ''))
      && /^[0-9]{12}$/.test(String(r.status.previousVersion || ''))
      && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(r.status.previousCompatibilityVersion || ''))
      && ['localhost', 'github-actions'].includes(String(r.status.previousBuildAuthority || ''))
      && String(r.status.previousRequestedRef || '').length > 0
      && String(r.status.previousSource || '').length > 0
      && /^[a-f0-9]{40}$/.test(String(r.status.previousRevision || ''))
      && String(r.status.previousSignatureIdentity || '').length > 0
      && (r.status.previousEvidenceRefs || []).length >= 2;
  }

  rollbackSummary(r: Registration): string {
    return `${this.displayName(r.name)}을 이전 검증 release로 되돌립니다.\n`
      + `현재: ${this.artifactVersion(r)} · ${this.shortDigest(r.status.currentDigest)}\n`
      + `대상: ${r.status.previousVersion || '미보고'} · ${this.shortDigest(r.status.previousDigest)}\n`
      + `서명·digest·source revision을 서버에서 다시 검증하고 승인 사유를 영구 감사에 기록합니다.`;
  }

  pendingRollbackRegistration(): Registration | null {
    const id = this.pendingRollback();
    return id ? this.registrations().find((registration) => registration.name === id) || null : null;
  }

  async run(action: 'enable' | 'disable' | 'uninstall' | 'rollback', id: string): Promise<void> {
    // The API is the gate; this only keeps the page from firing a request whose
    // refusal is already known, and it names the same missing capabilities the
    // button's tooltip does.
    const lock = action === 'enable' ? this.activationLockReason(id) : null;
    if (lock) {
      this.msg.set({ type: 'info', text: `활성화 대기 — ${lock} 플랫폼 제어에서 선행 조건과 4개 검증 증거를 확인하세요.` });
      return;
    }
    if (action === 'rollback') {
      const registration = this.registrations().find((item) => item.name === id);
      if (!registration || !this.rollbackAvailable(registration)) {
        this.msg.set({ type: 'danger', text: `rollback 실패: ${id}의 검증된 이전 release 증거가 없습니다.` });
        return;
      }
      this.pendingRollback.set(id);
      return;
    }
    this.pendingAction.set({ action, id });
  }

  async confirmAction(reason: string): Promise<void> {
    const pending = this.pendingAction();
    if (!pending) return;
    this.pendingAction.set(null);
    await this.execute(pending.action, pending.id, reason);
  }

  async confirmRollback(reason: string): Promise<void> {
    const id = this.pendingRollback();
    if (!id) return;
    this.pendingRollback.set(null);
    await this.execute('rollback', id, reason);
  }

  private async execute(action: 'enable' | 'disable' | 'uninstall' | 'rollback', id: string, reason: string): Promise<void> {
    try {
      if (action === 'rollback') await this.ctl.rollback(id, reason);
      else await this.ctl[action](id, reason);
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

  async installModule(image: string, reason: string): Promise<void> {
    if (this.installing()) return;
    this.installing.set(true);
    try {
      const result = await this.ctl.install(image, reason);
      const id = String((result as { id?: unknown })?.id || image);
      const operation = result.operation === 'Update' ? 'update' : 'install';
      this.extensionInstallImage.set('');
      this.extensionInstallReason.set('');
      this.msg.set({ type: 'info', text: `${operation} 요청됨: ${id} — 관리자 의도 ${result.desiredState}를 보존하며 검증과 workload를 조정 중…` });
      await this.refresh();
    } catch (error) {
      this.msg.set({ type: 'danger', text: `install 실패: ${String(error)}` });
    } finally {
      this.installing.set(false);
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
    const want = action === 'disable' ? 'Disabled' : 'Activated';
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
