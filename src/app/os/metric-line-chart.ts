import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'os-metric-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure [attr.aria-label]="label + ' 시계열'">
      <figcaption><span>{{ label }}</span><strong>{{ latestText }}</strong></figcaption>
      @if (values.length > 1) {
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" [attr.aria-label]="label + ' 변화 추세'">
          <line x1="0" y1="31.5" x2="100" y2="31.5" />
          <polyline [attr.points]="points" />
        </svg>
        <div class="range"><span>{{ minimumText }}</span><span>{{ maximumText }}</span></div>
      } @else {
        <div class="empty">표시할 시계열 지점이 부족합니다.</div>
      }
    </figure>
  `,
  styles: [`
    :host{display:block;min-width:0}
    figure{margin:0;padding:var(--os-5);border:1px solid var(--os-hairline);background:var(--os-canvas)}
    figcaption{display:flex;align-items:baseline;justify-content:space-between;gap:var(--os-4);margin-bottom:var(--os-4);color:var(--os-ink-muted);font-size:.75rem}
    figcaption strong{color:var(--os-ink);font-size:1rem}
    svg{display:block;inline-size:100%;block-size:5.5rem;overflow:visible}
    line{stroke:var(--os-hairline);stroke-width:.5;vector-effect:non-scaling-stroke}
    polyline{fill:none;stroke:var(--os-accent);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    .range{display:flex;justify-content:space-between;margin-top:var(--os-3);color:var(--os-ink-subtle);font-size:.625rem}
    .empty{display:grid;place-items:center;block-size:5.5rem;color:var(--os-ink-muted);font-size:.7rem;background:var(--os-surface-1)}
  `],
})
export class MetricLineChart {
  @Input({ required: true }) label = '';
  @Input() values: Array<number | null> = [];
  @Input() unit = '%';

  get numeric(): number[] { return this.values.filter((value): value is number => Number.isFinite(value)); }
  get minimum(): number { return this.numeric.length ? Math.min(...this.numeric) : 0; }
  get maximum(): number { return this.numeric.length ? Math.max(...this.numeric) : 0; }
  get latest(): number { return this.numeric.at(-1) ?? 0; }
  get latestText(): string { return `${this.latest.toFixed(this.unit === '%' ? 0 : 2)}${this.unit}`; }
  get minimumText(): string { return `최소 ${this.minimum.toFixed(1)}${this.unit}`; }
  get maximumText(): string { return `최대 ${this.maximum.toFixed(1)}${this.unit}`; }

  get points(): string {
    const values = this.values.map((value) => Number.isFinite(value) ? Number(value) : null);
    const numeric = values.filter((value): value is number => value !== null);
    if (numeric.length < 2) return '';
    const min = Math.min(...numeric);
    const max = Math.max(...numeric);
    const span = Math.max(max - min, 1);
    const denominator = Math.max(values.length - 1, 1);
    return values.map((value, index) => {
      const x = (index / denominator) * 100;
      const y = value === null ? 31 : 30 - ((value - min) / span) * 28;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }
}
