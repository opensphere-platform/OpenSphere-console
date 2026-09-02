import type { PtyServerFrame } from '@opensphere/console-contracts';
import type { OsShellFrameMessage } from './os-shell.types';

export const OS_SHELL_FRAME_CONTRACT = 'opensphere.shell.frame/v1' as const;
export const OS_SHELL_PTY_PROTOCOL = 'opensphere.pty.v1' as const;
export const MAX_STDIN_FRAME_BYTES = 8 * 1024;
export const MAX_SERVER_FRAME_BYTES = 256 * 1024;
export const MAX_TERMINAL_OUTPUT_BYTES = 128 * 1024;
export const MIN_COLS = 2;
export const MAX_COLS = 500;
export const MIN_ROWS = 2;
export const MAX_ROWS = 200;

export function validFrameMessage(value: unknown): value is OsShellFrameMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Partial<OsShellFrameMessage>;
  if (frame.contract !== OS_SHELL_FRAME_CONTRACT || typeof frame.type !== 'string') return false;
  if (frame.type === 'ready' || frame.type === 'detach') return true;
  if (!Number.isSafeInteger(frame.sequence) || Number(frame.sequence) < 1) return false;
  if (frame.type === 'stdin') {
    return typeof frame.data === 'string' && new TextEncoder().encode(frame.data).byteLength <= MAX_STDIN_FRAME_BYTES;
  }
  if (frame.type === 'activity') return true;
  if (frame.type === 'resize') {
    return Number.isInteger(frame.cols) && Number(frame.cols) >= MIN_COLS && Number(frame.cols) <= MAX_COLS
      && Number.isInteger(frame.rows) && Number(frame.rows) >= MIN_ROWS && Number(frame.rows) <= MAX_ROWS;
  }
  return false;
}

export function parseServerFrame(raw: unknown): PtyServerFrame | null {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_SERVER_FRAME_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (!Number.isSafeInteger(frame['sequence']) || Number(frame['sequence']) < 0 || typeof frame['type'] !== 'string') return null;
  const sequence = Number(frame['sequence']);
  if (frame['type'] === 'attached' && typeof frame['sessionId'] === 'string') {
    return { type: 'attached', sequence, sessionId: frame['sessionId'] };
  }
  if ((frame['type'] === 'stdout' || frame['type'] === 'stderr') && typeof frame['data'] === 'string'
      && new TextEncoder().encode(frame['data']).byteLength <= MAX_TERMINAL_OUTPUT_BYTES) {
    return { type: frame['type'], sequence, data: frame['data'] };
  }
  if (frame['type'] === 'exit' && Number.isInteger(frame['code'])) {
    return { type: 'exit', sequence, code: Number(frame['code']) };
  }
  if (frame['type'] === 'pong') return { type: 'pong', sequence };
  if ((frame['type'] === 'error' || frame['type'] === 'revoked')
      && typeof frame['code'] === 'string' && typeof frame['message'] === 'string'
      && frame['code'].length <= 128 && frame['message'].length <= 1024) {
    return { type: frame['type'], sequence, code: frame['code'], message: frame['message'] };
  }
  return null;
}
