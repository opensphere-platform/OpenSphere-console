import { ChangeDetectionStrategy, Component, Input, signal } from '@angular/core';
import Application16 from '@carbon/icons/es/application/16';
import { CarbonIcon, CarbonIconDescriptor } from './carbon-icon';
import { iconByToken } from './carbon-icon-catalog';

const CARBON_ICON_TOKEN = /^[a-z0-9][a-z0-9-]{0,95}$/;

/**
 * Main Shell navigation icon projection.
 *
 * Curated Carbon tokens render through the compact descriptor catalog. Every
 * other selectable token is a build-generated static SVG asset, so a document
 * requests only the icons it actually displays. Rendering never depends on
 * whether the administrator happened to open the 2600-icon picker first.
 */
@Component({
  selector: 'os-nav-icon',
  imports: [CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (descriptorForToken(); as icon) {
      <os-cicon [icon]="icon" [size]="size" />
    } @else if (assetUrl(); as url) {
      <img class="os-nav-icon-asset" [src]="url" alt="" [style.width.px]="size" [style.height.px]="size" (error)="assetFailed()" />
    } @else {
      <os-cicon [icon]="fallback" [size]="size" />
    }
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; flex: 0 0 auto; }
    .os-nav-icon-asset { display: block; object-fit: contain; opacity: 0.76; }
  `],
})
export class OsNavIcon {
  private currentToken = '';
  private readonly failedToken = signal('');
  @Input() set token(value: string) {
    const next = String(value || '');
    if (next !== this.currentToken) this.failedToken.set('');
    this.currentToken = next;
  }
  get token(): string { return this.currentToken; }
  @Input() fallback: CarbonIconDescriptor = Application16;
  @Input() size = 15;

  descriptorForToken(): CarbonIconDescriptor | null {
    return iconByToken(this.currentToken);
  }

  assetUrl(): string | null {
    if (!CARBON_ICON_TOKEN.test(this.currentToken) || this.failedToken() === this.currentToken) return null;
    return `/assets/carbon-icons/${encodeURIComponent(this.currentToken)}.svg`;
  }

  assetFailed(): void { this.failedToken.set(this.currentToken); }
}
