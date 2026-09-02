export type OsaaInlineToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'emphasis'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export type OsaaMessageBlock =
  | { type: 'paragraph'; content: OsaaInlineToken[] }
  | { type: 'heading'; level: number; content: OsaaInlineToken[] }
  | { type: 'quote'; content: OsaaInlineToken[] }
  | { type: 'list'; ordered: boolean; items: OsaaInlineToken[][] }
  | { type: 'code'; language: string; code: string }
  | { type: 'table'; header: OsaaInlineToken[][]; rows: OsaaInlineToken[][][] }
  | { type: 'rule' };

function safeLink(value: string): string {
  const href = value.trim();
  if (!/^https:\/\//i.test(href)) return '';
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

export function parseOsaaInline(value: string): OsaaInlineToken[] {
  const source = String(value || '');
  const tokens: OsaaInlineToken[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_([^_\n]+)_|\[[^\]\n]+\]\([^\s)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) tokens.push({ type: 'text', text: source.slice(cursor, match.index) });
    const token = match[0];
    if (token.startsWith('`')) tokens.push({ type: 'code', text: token.slice(1, -1) });
    else if (token.startsWith('**') || token.startsWith('__')) tokens.push({ type: 'strong', text: token.slice(2, -2) });
    else if (token.startsWith('*') || token.startsWith('_')) tokens.push({ type: 'emphasis', text: token.slice(1, -1) });
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = safeLink(link?.[2] || '');
      if (link && href) tokens.push({ type: 'link', text: link[1], href });
      else tokens.push({ type: 'text', text: token });
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) tokens.push({ type: 'text', text: source.slice(cursor) });
  return tokens.length ? tokens : [{ type: 'text', text: '' }];
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] || '';
  if (!line.trim()) return true;
  if (/^```/.test(line) || /^#{1,6}\s+/.test(line) || /^>\s?/.test(line)) return true;
  if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) return true;
  return index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1]);
}

export function parseOsaaMessage(value: string): OsaaMessageBlock[] {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: OsaaMessageBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^```\s*([a-z0-9_+.-]*)\s*$/i);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: (fence[1] || 'text').toLowerCase(), code: code.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, content: parseOsaaInline(heading[2]) });
      index += 1;
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      const header = tableCells(line).map(parseOsaaInline);
      const rows: OsaaInlineToken[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]).map(parseOsaaInline));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', content: parseOsaaInline(quote.join(' ')) });
      continue;
    }

    const listMatch = line.match(/^\s*((?:[-+*])|(?:\d+[.)]))\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const items: OsaaInlineToken[][] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*((?:[-+*])|(?:\d+[.)]))\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(parseOsaaInline(item[2]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) paragraph.push(lines[index++].trim());
    blocks.push({ type: 'paragraph', content: parseOsaaInline(paragraph.join(' ')) });
  }
  return blocks;
}
