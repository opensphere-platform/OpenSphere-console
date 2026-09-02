import { Component, Input, inject, ChangeDetectionStrategy } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * OsRawIcon — Carbon metadata 원본 SVG 문자열을 그대로 렌더(전체 라이브러리용).
 *   소스는 빌드시 번들된 @carbon/icons 패키지 → 신뢰 가능(bypassSecurityTrustHtml).
 *   fill:currentColor 로 색 상속, size(px)로 박스 크기.
 */
@Component({
  selector: 'os-rawicon',
  standalone: true,
  template: `<span class="os-rawicon" [style.width.px]="size" [style.height.px]="size" [innerHTML]="safe"></span>`,
  styles: [`
    .os-rawicon { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
    .os-rawicon ::ng-deep svg { width: 100%; height: 100%; fill: currentColor; display: block; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OsRawIcon {
  private san = inject(DomSanitizer);
  @Input() size = 16;
  safe: SafeHtml = '';
  @Input() set svg(v: string) { this.safe = this.san.bypassSecurityTrustHtml(v || ''); }
}
