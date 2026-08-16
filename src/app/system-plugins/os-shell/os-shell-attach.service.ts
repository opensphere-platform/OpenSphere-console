import { Injectable, NgZone, effect, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import type { PtyServerFrame } from '@opensphere/sdk';
import { OsShellSessionService } from './os-shell-session.service';
import {
  MAX_STDIN_FRAME_BYTES,
  OS_SHELL_FRAME_CONTRACT,
  OS_SHELL_PTY_PROTOCOL,
  parseServerFrame,
  validFrameMessage,
} from './os-shell-protocol';
import type { OsShellAttachState } from './os-shell.types';

const FRAME_READY_TIMEOUT_MS = 5000;
const ATTACH_TIMEOUT_MS = 15000;
// Keep the browser-side admission ceiling identical to the gateway/runtime
// contract. A looser Host limit would accept frames that the next boundary
// must terminate, turning ordinary typing/resize bursts into disconnects.
const MAX_INPUT_MESSAGES_PER_SECOND = 60;
const MAX_INPUT_BYTES_PER_SECOND = 64 * 1024;

export interface OsShellAttachHandle {
  readonly sessionId: string;
  close(reason?: string): void;
}

interface AttachOptions {
  readonly sessionId: string;
  readonly port: MessagePort;
  readonly onState: (state: OsShellAttachState, detail?: string) => void;
}

class RateWindow {
  private startedAt = performance.now();
  private messages = 0;
  private bytes = 0;

  accept(bytes: number): boolean {
    const now = performance.now();
    if (now - this.startedAt >= 1000) {
      this.startedAt = now;
      this.messages = 0;
      this.bytes = 0;
    }
    this.messages += 1;
    this.bytes += bytes;
    return this.messages <= MAX_INPUT_MESSAGES_PER_SECOND && this.bytes <= MAX_INPUT_BYTES_PER_SECOND;
  }
}

/**
 * Host-owned transport boundary. The opaque frame renders terminal bytes, but
 * never owns credentials or a WebSocket. The one-time ticket is sent only as
 * the first WSS application frame and is then discarded from this closure.
 */
@Injectable({ providedIn: 'root' })
export class OsShellAttachService {
  private readonly sessions = inject(OsShellSessionService);
  private readonly auth = inject(AuthService);
  private readonly zone = inject(NgZone);
  private readonly active = new Set<OsShellAttachHandle>();
  private previousSubject = '';

  constructor() {
    effect(() => {
      const subject = this.auth.subject();
      const invalid = this.auth.loginRequired() || !subject;
      const changed = Boolean(this.previousSubject) && this.previousSubject !== subject;
      this.previousSubject = subject;
      if (invalid || changed) this.closeAll('AuthenticationEnded');
    });
  }

  attach(options: AttachOptions): OsShellAttachHandle {
    const { sessionId, port, onState } = options;
    let socket: WebSocket | undefined;
    let closed = false;
    let ready = false;
    let connected = false;
    let lastClientSequence = 0;
    let lastServerSequence = -1;
    let retryCount = 0;
    let lastReportedState: OsShellAttachState = 'Idle';
    let retryTimer: number | undefined;
    let attachTimer: number | undefined;
    const rate = new RateWindow();

    const report = (state: OsShellAttachState, detail?: string) => {
      lastReportedState = state;
      this.zone.run(() => onState(state, detail));
      this.post(port, { contract: OS_SHELL_FRAME_CONTRACT, type: 'state', state, detail });
    };
    const clearTimers = () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (attachTimer !== undefined) window.clearTimeout(attachTimer);
      retryTimer = undefined;
      attachTimer = undefined;
    };
    const handle: OsShellAttachHandle = {
      sessionId,
      close: (reason = 'ClientDetached') => {
        if (closed) return;
        closed = true;
        clearTimers();
        port.onmessage = null;
        port.onmessageerror = null;
        try { port.close(); } catch { /* already closed */ }
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, reason.slice(0, 120));
        socket = undefined;
        this.active.delete(handle);
        if (!['Revoked', 'Failed', 'Terminated'].includes(lastReportedState)) report('Terminated', reason);
      },
    };

    const sendClientFrame = (frame: Record<string, unknown>) => {
      if (!socket || socket.readyState !== WebSocket.OPEN || !connected) return;
      socket.send(JSON.stringify(frame));
    };
    const onFrameMessage = (event: MessageEvent<unknown>) => {
      if (closed || !validFrameMessage(event.data)) return;
      const frame = event.data;
      if (frame.type === 'ready') {
        if (ready) return;
        ready = true;
        void connect(false);
        return;
      }
      if (frame.type === 'detach') {
        handle.close('ClientDetached');
        return;
      }
      const sequence = Number(frame.sequence);
      if (sequence <= lastClientSequence) return;
      lastClientSequence = sequence;
      if (frame.type === 'activity') {
        this.auth.recordTrustedActivity();
        return;
      }
      const size = frame.type === 'stdin' ? new TextEncoder().encode(frame.data ?? '').byteLength : 16;
      if (!rate.accept(size)) {
        handle.close('InputRateExceeded');
        return;
      }
      if (frame.type === 'stdin' && size <= MAX_STDIN_FRAME_BYTES) {
        sendClientFrame({ type: 'stdin', sequence, data: frame.data });
      } else if (frame.type === 'resize') {
        sendClientFrame({ type: 'resize', sequence, cols: frame.cols, rows: frame.rows });
      }
    };
    const forwardServerFrame = (frame: PtyServerFrame) => {
      if (frame.sequence <= lastServerSequence) return;
      lastServerSequence = frame.sequence;
      if (frame.type === 'attached') {
        if (frame.sessionId !== sessionId) {
          handle.close('SessionBindingMismatch');
          return;
        }
        connected = true;
        clearTimers();
        report('Attached');
        this.post(port, { contract: OS_SHELL_FRAME_CONTRACT, ...frame });
        return;
      }
      if (!connected && frame.type !== 'error' && frame.type !== 'revoked') return;
      this.post(port, { contract: OS_SHELL_FRAME_CONTRACT, ...frame });
      if (frame.type === 'revoked') {
        report('Revoked', frame.code);
        handle.close('PermissionRevoked');
      } else if (frame.type === 'exit') {
        report('Terminated', `exit:${frame.code}`);
        handle.close('ProcessExited');
      } else if (frame.type === 'error') {
        report('Failed', frame.code);
      }
    };
    const webSocketUrl = (): string => {
      const location = window.location;
      const loopback = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
      if (location.protocol !== 'https:' && !(location.protocol === 'http:' && loopback)) {
        throw new Error('SecureWebSocketOriginRequired');
      }
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${location.host}/api/os-shell/sessions/${encodeURIComponent(sessionId)}/attach`;
    };
    const reconnect = () => {
      if (closed || !this.auth.subject() || this.auth.loginRequired() || retryCount >= 2) {
        report('Failed', 'AttachDisconnected');
        return;
      }
      retryCount += 1;
      connected = false;
      lastServerSequence = -1;
      report('Reconnecting');
      retryTimer = window.setTimeout(() => void connect(true), retryCount * 750);
    };
    const connect = async (reconnecting: boolean) => {
      if (closed || !ready) return;
      try {
        report(reconnecting ? 'Reconnecting' : 'Checking');
        const issued = await this.sessions.issueAttachTicket(sessionId);
        if (closed) return;
        let attachTicket = issued.ticket;
        const candidate = new WebSocket(webSocketUrl(), [OS_SHELL_PTY_PROTOCOL]);
        socket = candidate;
        report('Attaching');
        attachTimer = window.setTimeout(() => {
          if (!connected && !closed) candidate.close(4000, 'AttachTimeout');
        }, ATTACH_TIMEOUT_MS);
        candidate.onopen = () => {
          if (closed) {
            candidate.close(1000, 'ClientDetached');
            return;
          }
          if (candidate.protocol !== OS_SHELL_PTY_PROTOCOL) {
            candidate.close(1002, 'ProtocolMismatch');
            return;
          }
          candidate.send(JSON.stringify({
            type: 'attach',
            sessionId: issued.sessionId,
            generation: issued.generation,
            fencingEpoch: issued.fencingEpoch,
            ticket: attachTicket,
          }));
          attachTicket = '';
        };
        candidate.onmessage = (event: MessageEvent<unknown>) => {
          const frame = parseServerFrame(event.data);
          if (!frame) {
            candidate.close(1003, 'FrameContractInvalid');
            return;
          }
          forwardServerFrame(frame);
        };
        candidate.onerror = () => { /* close event owns fail/reconnect state */ };
        candidate.onclose = (event) => {
          attachTicket = '';
          if (socket === candidate) socket = undefined;
          if (closed || event.code === 1000 || event.code === 1001) return;
          reconnect();
        };
      } catch (error) {
        if (closed) return;
        report('Failed', error instanceof Error ? error.message : 'AttachFailed');
      }
    };

    port.onmessage = onFrameMessage;
    port.onmessageerror = () => handle.close('FrameMessageInvalid');
    port.start();
    report('Checking');
    const frameTimer = window.setTimeout(() => {
      if (!ready && !closed) handle.close('TerminalFrameNotReady');
    }, FRAME_READY_TIMEOUT_MS);
    const originalClose = handle.close.bind(handle);
    handle.close = (reason?: string) => {
      window.clearTimeout(frameTimer);
      originalClose(reason);
    };
    this.active.add(handle);
    return handle;
  }

  private closeAll(reason: string): void {
    for (const handle of [...this.active]) handle.close(reason);
  }

  private post(port: MessagePort, value: unknown): void {
    try { port.postMessage(value); } catch { /* isolated frame already gone */ }
  }
}
