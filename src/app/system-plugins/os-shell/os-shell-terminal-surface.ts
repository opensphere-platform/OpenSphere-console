import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { OsShellAttachService, type OsShellAttachHandle } from './os-shell-attach.service';
import { OS_SHELL_FRAME_CONTRACT } from './os-shell-protocol';
import type { OsShellAttachState } from './os-shell.types';

@Component({
  selector: 'os-shell-terminal-surface',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="terminal-boundary" [attr.data-state]="state()">
      <iframe
        #frame
        class="terminal-frame"
        src="/os-shell-frame/index.html"
        sandbox="allow-scripts"
        title="OS Shell terminal"
        referrerpolicy="no-referrer"
        (load)="onFrameLoad()"
      ></iframe>
      @if (state() !== 'Attached') {
        <div class="terminal-state" role="status">
          <strong>{{ state() }}</strong>
          @if (detail()) { <span>{{ detail() }}</span> }
        </div>
      }
    </div>
  `,
  styleUrl: './os-shell-terminal-surface.scss',
})
export class OsShellTerminalSurface {
  private readonly attach = inject(OsShellAttachService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly frame = viewChild.required<ElementRef<HTMLIFrameElement>>('frame');
  private handle?: OsShellAttachHandle;
  private loaded = false;
  private currentSessionId = '';

  readonly state = signal<OsShellAttachState>('Idle');
  readonly detail = signal('');

  @Input({ required: true }) set sessionId(value: string) {
    const normalized = String(value || '').trim();
    if (normalized === this.currentSessionId) return;
    this.currentSessionId = normalized;
    this.disconnect('SessionChanged');
    if (this.loaded && normalized) this.connect();
  }

  @Output() readonly stateChange = new EventEmitter<{ state: OsShellAttachState; detail?: string }>();

  constructor() {
    this.destroyRef.onDestroy(() => this.disconnect('SurfaceDestroyed'));
  }

  onFrameLoad(): void {
    this.loaded = true;
    if (this.currentSessionId) this.connect();
  }

  private connect(): void {
    this.disconnect('ReconnectSurface');
    const target = this.frame().nativeElement.contentWindow;
    if (!target || !this.currentSessionId) {
      this.updateState('Failed', 'TerminalFrameUnavailable');
      return;
    }
    const channel = new MessageChannel();
    target.postMessage({ contract: OS_SHELL_FRAME_CONTRACT, type: 'initialize' }, '*', [channel.port2]);
    this.handle = this.attach.attach({
      sessionId: this.currentSessionId,
      port: channel.port1,
      onState: (state, detail) => this.updateState(state, detail),
    });
  }

  private disconnect(reason: string): void {
    this.handle?.close(reason);
    this.handle = undefined;
  }

  private updateState(state: OsShellAttachState, detail?: string): void {
    this.state.set(state);
    this.detail.set(detail ?? '');
    this.stateChange.emit(detail ? { state, detail } : { state });
  }
}
