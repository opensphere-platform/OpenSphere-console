// Shared host contract grammar: exact x.y.z, ^, ~, comparator intersections, ||.
// Unsupported syntax (including prereleases/wildcards) fails closed.
function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compare(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; }
function parse(range) {
  if (typeof range !== 'string' || !range.trim() || range.length > 128 || /[\u0000-\u001f\u007f]/.test(range)) return null;
  const groups = range.trim().split(/\s*\|\|\s*/);
  if (groups.length > 4) return null;
  const parsed = groups.map(group => group.split(/\s+/).map(term => {
    const m = term.match(/^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/);
    const v = m && version(m[2]);
    return v ? { op: m[1] || '=', version: v } : null;
  }));
  return parsed.every(group => group.length <= 8 && group.every(Boolean)) ? parsed : null;
}
export function validHostCompatibility(range) { return parse(range) !== null; }
export function hostCompatibilitySatisfied(actualVersion, range) {
  const actual = version(actualVersion), groups = parse(range);
  if (!actual || !groups) return false;
  return groups.some(group => group.every(({op, version: target}) => {
    const c = compare(actual, target);
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    if (op === '^' || op === '~') {
      const upper = op === '~' ? [target[0], target[1] + 1, 0]
        : target[0] > 0 ? [target[0] + 1, 0, 0]
        : target[1] > 0 ? [0, target[1] + 1, 0] : [0, 0, target[2] + 1];
      return c >= 0 && compare(actual, upper) < 0;
    }
    return c === 0;
  }));
}
