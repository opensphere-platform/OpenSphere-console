import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './os-shell-terminal-frame.css';

const CONTRACT = 'opensphere.shell.frame/v1';
const MAX_OUTPUT_FRAME_BYTES = 128 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDIN_FRAME_BYTES = 8 * 1024;
const MAX_PENDING_STDIN_BYTES = 256 * 1024;
const STDIN_DRAIN_INTERVAL_MS = 160;
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
  cursorBlink: true,
  cursorStyle: 'block',
  disableStdin: true,
  fontFamily: 'IBM Plex Mono, Cascadia Code, ui-monospace, monospace',
  fontSize: 14,
  lineHeight: 1.2,
  rightClickSelectsWord: true,
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
let pendingInputBytes = 0;
let inputDrainTimer: number | undefined;
const pendingInput: string[] = [];

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

function clearPendingInput(): void {
  if (inputDrainTimer !== undefined) window.clearTimeout(inputDrainTimer);
  inputDrainTimer = undefined;
  pendingInput.length = 0;
  pendingInputBytes = 0;
}

function splitInput(data: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const symbol of data) {
    const symbolBytes = new TextEncoder().encode(symbol).byteLength;
    if (chunk && chunkBytes + symbolBytes > MAX_STDIN_FRAME_BYTES) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += symbol;
    chunkBytes += symbolBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function drainInput(): void {
  if (inputDrainTimer !== undefined || !pendingInput.length) return;
  if (!attached || !port) {
    clearPendingInput();
    return;
  }
  const data = pendingInput.shift()!;
  pendingInputBytes = Math.max(0, pendingInputBytes - new TextEncoder().encode(data).byteLength);
  post({ type: 'stdin', sequence: ++sequence, data });
  if (pendingInput.length) {
    inputDrainTimer = window.setTimeout(() => {
      inputDrainTimer = undefined;
      drainInput();
    }, STDIN_DRAIN_INTERVAL_MS);
  }
}

function queueInput(data: string): void {
  const bytes = new TextEncoder().encode(data).byteLength;
  if (!bytes) return;
  if (pendingInputBytes + bytes > MAX_PENDING_STDIN_BYTES) {
    terminal.write('\r\n[OS Shell: paste exceeds the 256 KiB input limit]\r\n');
    terminal.focus();
    return;
  }
  pendingInput.push(...splitInput(data));
  pendingInputBytes += bytes;
  drainInput();
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
      clearPendingInput();
      break;
    case 'exit':
      attached = false;
      terminal.options.disableStdin = true;
      clearPendingInput();
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
    clearPendingInput();
  };
  port.start();
  post({ type: 'ready' });
  resize();
}, { once: false });

terminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown') return true;
  const primaryModifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (primaryModifier && key === 'c' && (event.shiftKey || terminal.hasSelection())) return false;
  if (primaryModifier && key === 'v') return false;
  if (event.key === 'Insert' && (event.ctrlKey || event.shiftKey)) return false;
  return true;
});

terminal.onData((data) => {
  if (!attached || !port) return;
  queueInput(data);
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
  clearPendingInput();
  observer.disconnect();
  terminal.dispose();
  try { port?.close(); } catch { /* already closed */ }
  port = undefined;
}, { once: true });
