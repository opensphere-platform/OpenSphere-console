import { Component, OnInit, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { OsPageHeader } from '../os/os-page-header';
import { OsRawIcon } from '../os/os-raw-icon';
import { IconLibraryService } from '../os/icon-library.service';
import { ExtensionHostService } from '../core/extension-host.service';
import {
  PluginControlClient,
  CatalogItem,
  Registration,
  AuditEvent,
  Binding,
} from '../core/plugin-control-client.service';

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
  imports: [ClarityModule, OsPageHeader, OsRawIcon],
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

    <div class="os-summary">
      <span class="label label-info">Catalog {{ catalog().length }}</span>
      <span class="label label-success">Enabled {{ countPhase('Enabled') }}</span>
      <span class="label">Disabled {{ countPhase('Disabled') }}</span>
      <span class="label label-danger">Failed {{ countPhase('Failed') }}</span>
      <span class="label label-info">Bindings {{ bindings().length }}</span>
    </div>

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
                        [class.label-success]="c.phase === 'Enabled'"
                        [class.label-danger]="c.phase === 'Failed'"
                        >{{ c.phase }}</span
                      >
                    }
                    @if (c.actionable && c.phase) {
                      @if (c.phase === 'Enabled') {
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
                          <span class="label" [class.label-success]="g.phase === 'Enabled'">{{
                            g.phase
                          }}</span>
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
          <p class="os-sub">
            Enable/Disable만 여기서. 삭제(Uninstall)는 Catalog 탭에서 Disabled 상태일 때만.
          </p>
          <table class="table">
            <thead>
              <tr>
                <th class="left">Plugin</th>
                <th>State</th>
                <th>Reason</th>
                <th>Requested by</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (r of registrations(); track r.name) {
                <tr>
                  <td class="left">{{ r.name }}</td>
                  <td>
                    <span
                      class="label"
                      [class.label-success]="r.status.phase === 'Enabled'"
                      [class.label-danger]="r.status.phase === 'Failed'"
                      >{{ r.status.phase ?? '—' }}</span
                    >
                  </td>
                  <td>{{ r.status.reason || '—' }}</td>
                  <td>{{ r.approval?.requestedBy ?? '—' }}</td>
                  <td>
                    @if (r.status.phase === 'Enabled') {
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
                  <td colspan="5" class="os-sub">설치된 플러그인 없음 — Catalog 탭에서 설치</td>
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
                        [class.label-success]="ph === 'Enabled'"
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
      <div class="cc-drawer-backdrop" (click)="closePanel()"></div>
      <aside class="cc-drawer" role="dialog" aria-label="플러그인 상태">
        <div class="cc-drawer-head">
          <div>
            <div class="cc-drawer-title">{{ selectedLabel() }}</div>
            <div class="cc-drawer-sub os-mono">{{ r.name }}</div>
          </div>
          <button class="btn btn-sm btn-link" (click)="closePanel()">✕</button>
        </div>

        <div class="cc-state cc-state-{{ (r.status.phase || 'Unknown').toLowerCase() }}">
          <span class="cc-dot"></span>
          <strong>{{ r.status.phase || 'Unknown' }}</strong>
          <span class="cc-desired">목표: {{ r.desiredState }}</span>
        </div>

        @if (r.status.phase === 'Failed' && r.status.reason) {
          <div class="cc-reason">
            <strong>사유</strong>
            <div>{{ reasonText(r.status.reason) }} <span class="os-mono">({{ r.status.reason }})</span></div>
          </div>
        }

        <div class="cc-steps">
          <div class="cc-steps-h">검증 진행 단계</div>
          @for (s of steps(); track s.label) {
            <div class="cc-step cc-step-{{ s.state }}">
              <span class="cc-step-ic">{{ s.state === 'done' ? '✓' : s.state === 'fail' ? '✗' : s.state === 'active' ? '⋯' : '○' }}</span>
              <span>{{ s.label }}</span>
            </div>
          }
        </div>

        <dl class="cc-kv">
          <dt>상태(phase)</dt><dd>{{ r.status.phase || '—' }}</dd>
          <dt>사유(reason)</dt><dd>{{ r.status.reason || '—' }}</dd>
          <dt>마지막 변경</dt><dd class="os-mono">{{ r.status.lastTransitionTime || '—' }}</dd>
          <dt>manifest</dt><dd class="os-mono cc-break">{{ r.status.manifestUrl || '—' }}</dd>
          <dt>요청자</dt><dd>{{ r.approval?.requestedBy || '—' }}</dd>
          <dt>승인 사유</dt><dd>{{ r.approval?.reason || '—' }}</dd>
        </dl>

        <!-- 1단 아이콘 선택(IBM Carbon) — 기본값 + 사용자 선택. spec.nav.icon 패치. -->
        <div class="cc-iconpick">
          <div class="cc-iconpick-h">1단 아이콘 <span class="os-mono">{{ iconToken() || '(기본)' }}</span></div>
          <input class="cc-iconsearch" type="search" placeholder="아이콘 검색…"
                 [value]="iconQuery()" (input)="iconQuery.set($any($event.target).value)" />
          <div class="cc-iconpick-note">
            {{ iconLib.list().length ? (iconMatchCount() + '개 일치' + (iconMatchCount() > iconList().length ? (' · 상위 ' + iconList().length + '개 표시(검색으로 좁히기)') : '')) : '라이브러리 로딩 중…' }}
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

        <div class="cc-actions">
          @if (r.status.phase === 'Enabled') {
            <button class="btn btn-sm" (click)="run('disable', r.name)">Disable</button>
          } @else {
            <button class="btn btn-sm btn-success-outline" (click)="run('enable', r.name)">Enable (재검증)</button>
          }
          <button class="btn btn-sm btn-danger-outline" (click)="run('uninstall', r.name)">Uninstall</button>
        </div>

        @if (r.status.phase === 'Failed') {
          <p class="os-sub">서명 검증 실패 시 nav에 노출되지 않습니다(보안 게이트). 유효 서명으로 재배포 후 Enable(재검증)하세요.</p>
        }
      </aside>
    }
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
      .os-summary {
        margin: 0.4rem 0 0.8rem;
      }
      .os-summary .label {
        margin-right: 0.3rem;
      }
      .table .left {
        text-align: left;
      }
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

      /* 우측 슬라이드 상세 패널 */
      .cc-drawer-backdrop { position: fixed; inset: 0; background: rgba(22, 22, 22, 0.32); z-index: 1000; }
      .cc-drawer {
        position: fixed; top: 0; right: 0; bottom: 0; width: 24rem; max-width: 92vw; z-index: 1001;
        background: #fff; border-left: 1px solid var(--os-hairline); box-shadow: var(--os-elev-overlay);
        padding: 1.1rem 1.25rem; overflow-y: auto;
      }
      .cc-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
      .cc-drawer-title { font-size: 1.15rem; font-weight: 600; color: var(--os-ink); }
      .cc-drawer-sub { color: var(--os-ink-subtle); font-size: 0.72rem; margin-top: 0.1rem; }
      .cc-state {
        display: flex; align-items: center; gap: 0.5rem; margin: 0.9rem 0; padding: 0.55rem 0.75rem;
        border-radius: var(--os-radius); background: var(--os-surface-1); font-size: 0.9rem; color: var(--os-ink);
      }
      .cc-state .cc-desired { margin-left: auto; font-size: 0.72rem; color: var(--os-ink-muted); }
      .cc-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--os-ink-subtle); flex: 0 0 auto; }
      .cc-state-enabled .cc-dot { background: var(--os-success); }
      .cc-state-failed .cc-dot { background: var(--os-error); }
      .cc-state-disabled .cc-dot { background: var(--os-warning); }
      .cc-state-failed { background: rgba(218, 30, 40, 0.08); }
      .cc-reason { margin: 0 0 0.9rem; padding: 0.6rem 0.75rem; border-left: 3px solid var(--os-error); background: rgba(218, 30, 40, 0.06); font-size: 0.82rem; }
      .cc-reason strong { display: block; color: var(--os-error); margin-bottom: 0.15rem; }
      .cc-kv { display: grid; grid-template-columns: 6rem 1fr; gap: 0.35rem 0.6rem; margin: 0.6rem 0 1rem; font-size: 0.8rem; }
      .cc-kv dt { color: var(--os-ink-muted); }
      .cc-kv dd { margin: 0; color: var(--os-ink); }
      .cc-break { word-break: break-all; }
      .cc-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.8rem; }

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
    `,
  ],
})
export class AdminPlugins implements OnInit {
  private ctl = inject(PluginControlClient);
  private ext = inject(ExtensionHostService);
  readonly iconLib = inject(IconLibraryService);

  readonly catalog = signal<CatalogItem[]>([]);
  readonly registrations = signal<Registration[]>([]);
  readonly events = signal<AuditEvent[]>([]);
  readonly bindings = signal<Binding[]>([]);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
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
    { label: '레지스트리 등록 · nav 노출' },
  ];
  steps(): { label: string; state: 'done' | 'fail' | 'pending' | 'active' }[] {
    const r = this.selectedReg();
    if (!r) return [];
    const phase = r.status.phase;
    const reason = r.status.reason;
    if (phase === 'Enabled') return this.VSTEPS.map((s) => ({ label: s.label, state: 'done' }));
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
      const [c, r, e, b] = await Promise.all([
        this.ctl.catalog(),
        this.ctl.registrations(),
        this.ctl.events(),
        this.ctl.bindings(),
      ]);
      this.catalog.set(c);
      this.registrations.set(r);
      this.events.set(e);
      this.bindings.set(b);
    } catch (err) {
      this.msg.set({ type: 'danger', text: String(err) });
    }
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
    if (
      action === 'uninstall' &&
      !confirm(`'${id}' 삭제 — 메뉴와 워크로드가 제거됩니다. 진행할까요?`)
    )
      return;
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
    const want = action === 'disable' ? 'Disabled' : 'Enabled';
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
