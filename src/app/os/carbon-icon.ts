import { Component, Input, ChangeDetectionStrategy, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Carbon 아이콘 렌더러 (Angular 22 + Clarity 환경).
 * 공식 `@carbon/icons-angular`는 Angular 11에 고정(peer)이라 22 비호환 → 프레임워크 무관한
 * `@carbon/icons`의 SVG 디스크립터({elem,attrs,content})를 직접 직렬화해 렌더한다(아이콘=SVG뿐, Clarity와 무충돌).
 * 사용: import Search16 from '@carbon/icons/es/search/16'; <os-cicon [icon]="Search16" [size]="16"/>
 */
interface IconNode { elem: string; attrs?: Record<string, unknown>; content?: IconNode[]; }

@Component({
  selector: 'os-cicon',
  template: `<span class="os-cicon" [innerHTML]="html"></span>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`:host{display:inline-flex} .os-cicon{display:inline-flex;line-height:0} .os-cicon ::ng-deep svg{fill:currentColor}`],
})
export class CarbonIcon {
  private san = inject(DomSanitizer);
  html: SafeHtml = '';
  private _d?: IconNode;
  private _s = 16;

  @Input({ required: true }) set icon(d: IconNode) { this._d = d; this.render(); }
  @Input() set size(s: number) { this._s = s; this.render(); }

  private render(): void {
    if (!this._d) return;
    const root: IconNode = { ...this._d, attrs: { ...this._d.attrs, width: this._s, height: this._s } };
    this.html = this.san.bypassSecurityTrustHtml(this.toStr(root));
  }
  private toStr(n: IconNode): string {
    const a = Object.entries(n.attrs || {}).map(([k, v]) => `${k}="${String(v)}"`).join(' ');
    const inner = (n.content || []).map((c) => this.toStr(c)).join('');
    return `<${n.elem} ${a}>${inner}</${n.elem}>`;
  }
}
