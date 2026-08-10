import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { R2d2RiskService } from '../core/r2d2-risk.service';

@Component({
  selector: 'os-r2d2-risk',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/manage/oaa" class="r2d2-risk" [class.attention]="risk.risk().severityRank >= 2" [class.critical]="risk.risk().severityRank >= 3"
      [attr.aria-label]="label()" [title]="label()">
      <span class="r2d2-mark">R2</span>
      @if (risk.risk().state === 'known') { <strong>{{ risk.risk().active }}</strong>@if (risk.routeIncidentCount()) { <em>{{ risk.routeIncidentCount() }}</em> } }
      @else { <strong>?</strong> }
    </a>
  `,
  styles: [`
    .r2d2-risk{display:inline-flex;align-items:center;gap:.25rem;min-height:2.1rem;padding:0 .5rem;border:1px solid rgba(199,208,232,.35);border-radius:999px;color:#dce6ef;text-decoration:none}
    .r2d2-risk:hover{background:rgba(255,255,255,.08);color:#fff}.r2d2-mark{font-size:.58rem;font-weight:700;letter-spacing:.04em}.r2d2-risk strong{min-width:1rem;text-align:center;font-size:.68rem}
    .r2d2-risk em{display:inline-grid;place-items:center;min-width:.9rem;height:.9rem;border-radius:50%;background:#2f6fca;color:#fff;font-size:.5rem;font-style:normal}.r2d2-risk.attention{border-color:#f2b84b;color:#ffe6ad}.r2d2-risk.critical{border-color:#ff7770;background:rgba(179,38,30,.24);color:#ffd6d3}
  `],
})
export class OsR2d2Risk implements OnInit, OnDestroy {
  readonly risk = inject(R2d2RiskService);
  ngOnInit(): void { this.risk.start(); }
  ngOnDestroy(): void { this.risk.stop(); }
  label(): string {
    const state = this.risk.risk();
    if (state.state !== 'known') return `R2D2 operational risk: ${state.state}`;
    return `R2D2 active operational risks ${state.active}, current route related ${this.risk.routeIncidentCount()}, severity rank ${state.severityRank}`;
  }
}
