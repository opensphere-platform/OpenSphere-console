import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { ExtensionHostService } from '../core/extension-host.service';
import {
  PluginControlClient,
  CatalogItem,
  Registration,
  AuditEvent,
} from '../core/plugin-control-client.service';

/**
 * Admin Control Page (계획서 §7) — Catalog/Installed/Audit 탭.
 * 설치/비활성화/재활성화/삭제를 Control API로만 수행하고, 성공 후 Extension Host를
 * reload하여 메뉴를 런타임 갱신한다. 셸 이미지·파드는 불변(DUPA 합격 기준).
 */
@Component({
  selector: 'os-admin-plugins',
  imports: [ClarityModule],
  template: `
    <h1>Plugins <span class="os-engine">Admin Control</span></h1>
    <p class="os-sub">DUPA 플러그인 설치·비활성화·삭제 — 셸 리빌드 없이 (계획서 §7)</p>

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
    </div>

    <clr-tabs>
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
    </clr-tabs>
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
    `,
  ],
})
export class AdminPlugins implements OnInit {
  private ctl = inject(PluginControlClient);
  private ext = inject(ExtensionHostService);

  readonly catalog = signal<CatalogItem[]>([]);
  readonly registrations = signal<Registration[]>([]);
  readonly events = signal<AuditEvent[]>([]);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const [c, r, e] = await Promise.all([
        this.ctl.catalog(),
        this.ctl.registrations(),
        this.ctl.events(),
      ]);
      this.catalog.set(c);
      this.registrations.set(r);
      this.events.set(e);
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
