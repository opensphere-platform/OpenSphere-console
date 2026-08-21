import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { parseOsaaMessage } from './osaa-message-parser';

@Component({
  selector: 'os-osaa-message-content',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="osaa-rendered-message">
      @for (block of blocks(); track $index) {
        @switch (block.type) {
          @case ('heading') {
            <div class="osaa-md-heading" [class]="'osaa-md-heading osaa-md-h' + block.level"><ng-container *ngTemplateOutlet="inline; context: { $implicit: block.content }" /></div>
          }
          @case ('paragraph') { <p><ng-container *ngTemplateOutlet="inline; context: { $implicit: block.content }" /></p> }
          @case ('quote') { <blockquote><ng-container *ngTemplateOutlet="inline; context: { $implicit: block.content }" /></blockquote> }
          @case ('list') {
            @if (block.ordered) {
              <ol>@for (item of block.items; track $index) { <li><ng-container *ngTemplateOutlet="inline; context: { $implicit: item }" /></li> }</ol>
            } @else {
              <ul>@for (item of block.items; track $index) { <li><ng-container *ngTemplateOutlet="inline; context: { $implicit: item }" /></li> }</ul>
            }
          }
          @case ('code') {
            <section class="osaa-code-block">
              <header><span>{{ block.language }}</span><button type="button" (click)="copyCode(block.code)">{{ copied() === block.code ? '복사됨' : '복사' }}</button></header>
              <pre><code>{{ block.code }}</code></pre>
            </section>
          }
          @case ('table') {
            <div class="osaa-table-scroll"><table><thead><tr>@for (cell of block.header; track $index) { <th><ng-container *ngTemplateOutlet="inline; context: { $implicit: cell }" /></th> }</tr></thead>
              <tbody>@for (row of block.rows; track $index) { <tr>@for (cell of row; track $index) { <td><ng-container *ngTemplateOutlet="inline; context: { $implicit: cell }" /></td> }</tr> }</tbody>
            </table></div>
          }
          @case ('rule') { <hr /> }
        }
      }
    </div>

    <ng-template #inline let-tokens>
      @for (token of tokens; track $index) {
        @switch (token.type) {
          @case ('strong') { <strong>{{ token.text }}</strong> }
          @case ('emphasis') { <em>{{ token.text }}</em> }
          @case ('code') { <code class="osaa-inline-code">{{ token.text }}</code> }
          @case ('link') { <a [href]="token.href" target="_blank" rel="noopener noreferrer">{{ token.text }}</a> }
          @default { <span>{{ token.text }}</span> }
        }
      }
    </ng-template>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .osaa-rendered-message { color: inherit; font-size: 14px; line-height: 1.62; overflow-wrap: anywhere; }
    p { margin: 0 0 10px; white-space: normal; }
    p:last-child { margin-bottom: 0; }
    .osaa-md-heading { color: #172733; font-weight: 650; line-height: 1.3; margin: 14px 0 8px; }
    .osaa-md-h1 { font-size: 1.3rem; } .osaa-md-h2 { font-size: 1.18rem; } .osaa-md-h3 { font-size: 1.08rem; }
    .osaa-md-h4, .osaa-md-h5, .osaa-md-h6 { font-size: 1rem; }
    ul, ol { margin: 6px 0 12px 22px; padding: 0; } li { margin: 3px 0; padding-left: 3px; }
    blockquote { margin: 10px 0; padding: 8px 12px; border-left: 3px solid #6f8f9d; background: #f5f8f9; color: #304a56; }
    hr { border: 0; border-top: 1px solid #d8e0e4; margin: 14px 0; }
    a { color: #0068b5; text-decoration: underline; text-underline-offset: 2px; }
    .osaa-inline-code { padding: 1px 5px; border-radius: 3px; background: #edf1f3; color: #243746; font: 0.92em/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .osaa-code-block { margin: 10px 0 14px; border: 1px solid #cbd6dc; border-radius: 5px; overflow: hidden; background: #111820; color: #edf4f7; }
    .osaa-code-block header { display: flex; align-items: center; justify-content: space-between; min-height: 31px; padding: 0 8px 0 12px; background: #202b34; color: #c5d2d8; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .osaa-code-block button { border: 0; border-radius: 3px; padding: 3px 8px; background: transparent; color: #dce7eb; cursor: pointer; }
    .osaa-code-block button:hover { background: #34434e; }
    pre { max-width: 100%; margin: 0; padding: 13px 14px; overflow-x: auto; white-space: pre; tab-size: 2; }
    pre code { color: inherit; font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .osaa-table-scroll { max-width: 100%; margin: 10px 0 14px; overflow-x: auto; }
    table { width: 100%; min-width: 360px; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 7px 9px; border: 1px solid #d6dfe3; text-align: left; vertical-align: top; }
    th { background: #f1f5f6; color: #233943; font-weight: 650; }
  `],
})
export class OsaaMessageContent {
  private readonly value = signal('');
  readonly blocks = computed(() => parseOsaaMessage(this.value()));
  readonly copied = signal('');

  @Input({ required: true }) set content(value: string) { this.value.set(String(value || '')); }

  async copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      this.copied.set(code);
      setTimeout(() => this.copied.set(''), 1400);
    } catch {
      this.copied.set('');
    }
  }
}
