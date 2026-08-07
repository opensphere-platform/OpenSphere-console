import { ChangeDetectionStrategy, Component, inject, Input } from '@angular/core';
import Application16 from '@carbon/icons/es/application/16';
import { CarbonIcon, CarbonIconDescriptor } from './carbon-icon';
import { iconByToken } from './carbon-icon-catalog';
import { IconLibraryService } from './icon-library.service';
import { OsRawIcon } from './os-raw-icon';

/**
 * Main Shell navigation icon projection.
 *
 * Curated Carbon tokens render through the compact descriptor catalog. Tokens
 * outside that catalog use the same full metadata library as the management
 * icon picker. A missing or unresolved token always falls back explicitly.
 */
@Component({
  selector: 'os-nav-icon',
  imports: [CarbonIcon, OsRawIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (rawSvg(); as svg) {
      <os-rawicon [svg]="svg" [size]="size" />
    } @else {
      <os-cicon [icon]="descriptor()" [size]="size" />
    }
  `,
})
export class OsNavIcon {
  @Input() token = '';
  @Input() fallback: CarbonIconDescriptor = Application16;
  @Input() size = 20;

  private readonly iconLibrary = inject(IconLibraryService);

  rawSvg(): string | null {
    if (!this.token || iconByToken(this.token)) return null;
    return this.iconLibrary.getSvg(this.token);
  }

  descriptor(): CarbonIconDescriptor {
    return iconByToken(this.token) ?? this.fallback;
  }
}
