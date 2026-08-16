import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './os-shell-terminal-frame.css';

const CONTRACT = 'opensphere.shell.frame/v1';
const MAX_OUTPUT_FRAME_BYTES = 128 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDIN_FRAME_BYTES = 8 * 1024;
const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 200;

const root = document.getElementById('terminal');
if (!root) throw new Error('TerminalRootMissing');

const terminal = new Terminal({
  allowProposedApi: false,
  allowTransparency: false,
  convertEol: false,
  cursorBlink: false,
  disableStdin: true,
  fontFamily: 'IBM Plex Mono, Cascadia Code, ui-monospace, monospace',
  fontSize: 14,
  lineHeight: 1.2,
  scrollback: 1000,
  theme: {
    background: '#101010',
    foreground: '#f4f4f4',
    cursor: '#78a9ff',
    selectionBackground: '#264f78',
  },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(root);

let port: MessagePort | undefined;
let initialized = false;
let attached = false;
let sequence = 0;
let pendingOutputBytes = 0;

function post(value: Record<string, unknown>): void {
  try { port?.postMessage({ contract: CONTRACT, ...value }); } catch { /* Host has torn down the surface. */ }
}

function boundedDimensions(): { cols: number; rows: number } {
  return {
    cols: Math.max(MIN_COLS, Math.min(MAX_COLS, terminal.cols || 80)),
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, terminal.rows || 24)),
  };
}

function resize(): void {
  try { fit.fit(); } catch { return; }
  const dimensions = boundedDimensions();
  post({ type: 'resize', sequence: ++sequence, ...dimensions });
}

function write(data: string): void {
  const bytes = new TextEncoder().encode(data).byteLength;
  if (bytes > MAX_OUTPUT_FRAME_BYTES || pendingOutputBytes + bytes > MAX_PENDING_OUTPUT_BYTES) {
    attached = false;
    terminal.options.disableStdin = true;
    post({ type: 'detach' });
    return;
  }
  pendingOutputBytes += bytes;
  terminal.write(data, () => { pendingOutputBytes = Math.max(0, pendingOutputBytes - bytes); });
}

function acceptHostFrame(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const frame = value as Record<string, unknown>;
  if (frame['contract'] !== CONTRACT || typeof frame['type'] !== 'string') return;
  switch (frame['type']) {
    case 'attached':
      attached = true;
      terminal.options.disableStdin = false;
      terminal.focus();
      resize();
      break;
    case 'stdout':
    case 'stderr':
      if (attached && typeof frame['data'] === 'string') write(frame['data']);
      break;
    case 'revoked':
    case 'error':
      attached = false;
      terminal.options.disableStdin = true;
      break;
    case 'exit':
      attached = false;
      terminal.options.disableStdin = true;
      write('\r\n[session ended]\r\n');
      break;
    case 'state':
    case 'pong':
      break;
    default:
      break;
  }
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (initialized || event.source !== window.parent || event.ports.length !== 1) return;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
  const message = event.data as Record<string, unknown>;
  if (message['contract'] !== CONTRACT || message['type'] !== 'initialize') return;
  initialized = true;
  port = event.ports[0];
  port.onmessage = (portEvent) => acceptHostFrame(portEvent.data);
  port.onmessageerror = () => {
    attached = false;
    terminal.options.disableStdin = true;
  };
  port.start();
  post({ type: 'ready' });
  resize();
}, { once: false });

terminal.onData((data) => {
  if (!attached || !port) return;
  if (new TextEncoder().encode(data).byteLength > MAX_STDIN_FRAME_BYTES) return;
  post({ type: 'stdin', sequence: ++sequence, data });
});

const trustedActivity = (event: Event) => {
  if (!attached || !port || !event.isTrusted) return;
  post({ type: 'activity', sequence: ++sequence });
};
window.addEventListener('pointerdown', trustedActivity, { passive: true });
window.addEventListener('keydown', trustedActivity);
window.addEventListener('touchstart', trustedActivity, { passive: true });

const observer = new ResizeObserver(() => {
  if (initialized) resize();
});
observer.observe(root);

window.addEventListener('pagehide', () => {
  if (attached) post({ type: 'detach' });
  observer.disconnect();
  terminal.dispose();
  try { port?.close(); } catch { /* already closed */ }
  port = undefined;
}, { once: true });
