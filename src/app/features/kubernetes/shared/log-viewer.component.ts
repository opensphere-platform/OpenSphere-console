import { CommonModule } from '@angular/common';
import { Component, ElementRef, Input, ViewChild, computed, effect, signal } from '@angular/core';

/** 로그 한 줄을 렌더 세그먼트로: text + ANSI 색 클래스 + 전역 매치 인덱스(gi, 없으면 -1). */
interface Seg { text: string; cls: string; gi: number; }
interface Run { s: number; e: number; cls: string; }

const BASIC = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** ANSI SGR(\x1b[..m) 파싱 → 평문 + 색 run. 비-SGR CSI(\x1b[..K 등)는 제거. */
function parseAnsi(line: string): { plain: string; runs: Run[] } {
  const re = /\x1b\[[0-9;?]*[A-Za-z]/g;
  const runs: Run[] = [];
  let plain = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  const st = { fg: '', bold: false, dim: false };
  const cls = () => [st.fg ? 'a-' + st.fg : '', st.bold ? 'a-b' : '', st.dim ? 'a-d' : ''].filter(Boolean).join(' ');
  const push = (chunk: string) => { if (chunk) { runs.push({ s: plain.length, e: plain.length + chunk.length, cls: cls() }); plain += chunk; } };
  while ((m = re.exec(line))) {
    push(line.slice(cursor, m.index));
    const seq = m[0];
    if (seq.endsWith('m')) applySGR(st, seq.slice(2, -1)); // SGR만 색 적용, 나머지 CSI는 제거
    cursor = re.lastIndex;
  }
  push(line.slice(cursor));
  return { plain, runs };
}

function applySGR(st: { fg: string; bold: boolean; dim: boolean }, codes: string): void {
  const parts = (codes || '0').split(';').map(s => parseInt(s || '0', 10));
  for (let i = 0; i < parts.length; i++) {
    const n = parts[i];
    if (n === 0) { st.fg = ''; st.bold = false; st.dim = false; }
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 22) { st.bold = false; st.dim = false; }
    else if (n >= 30 && n <= 37) st.fg = BASIC[n - 30];
    else if (n === 39) st.fg = '';
    else if (n >= 90 && n <= 97) st.fg = 'br-' + BASIC[n - 90];
    else if (n === 38 || n === 48) { if (parts[i + 1] === 5) i += 2; else if (parts[i + 1] === 2) i += 4; } // 256/truecolor 인자 스킵
    // 배경(40-47,100-107) 무시
  }
}

function buildSegs(p: { plain: string; runs: Run[] }, lineMatches: { s: number; e: number; gi: number }[]): Seg[] {
  const n = p.plain.length;
  if (n === 0) return [{ text: '', cls: '', gi: -1 }];
  const clsArr: string[] = new Array(n).fill('');
  for (const r of p.runs) for (let i = r.s; i < r.e; i++) clsArr[i] = r.cls;
  const mArr: number[] = new Array(n).fill(-1);
  for (const m of lineMatches) for (let i = m.s; i < m.e && i < n; i++) mArr[i] = m.gi;
  const segs: Seg[] = [];
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && clsArr[j] === clsArr[i] && mArr[j] === mArr[i]) j++;
    segs.push({ text: p.plain.slice(i, j), cls: clsArr[i], gi: mArr[i] });
    i = j;
  }
  return segs;
}

/** 로그 전용 뷰어 — ANSI 색상 렌더 + 검색(노란 하이라이트·이전/다음·매치수) + 줄바꿈 토글. 자체완결(외부 의존 없음). */
@Component({
  selector: 'app-log-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="lv-shell">
      <div class="lv-toolbar">
        <svg viewBox="0 0 24 24" class="os-ic" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z"/></svg>
        <input class="lv-search" type="text" [value]="query()" (input)="onInput($any($event.target).value)" (keydown.enter)="next()" placeholder="로그 검색" />
        <span class="lv-count" *ngIf="query()">{{ matchCount() ? (currentIdx() + 1) + ' / ' + matchCount() : '0' }}</span>
        <button type="button" class="os-iconbtn" title="이전 매치" [disabled]="!matchCount()" (click)="prev()"><svg viewBox="0 0 24 24" class="os-ic"><path d="M7 14l5-5 5 5z"/></svg></button>
        <button type="button" class="os-iconbtn" title="다음 매치" [disabled]="!matchCount()" (click)="next()"><svg viewBox="0 0 24 24" class="os-ic"><path d="M7 10l5 5 5-5z"/></svg></button>
        <span class="cm-spacer"></span>
        <label class="os-wrap-toggle"><input type="checkbox" [checked]="wrapOn()" (change)="wrapOn.set($any($event.target).checked)" /> 줄바꿈</label>
      </div>
      <div class="lv-body" [class.wrap]="wrapOn()" [style.height]="height" #body>
        <div class="lv-line" *ngFor="let segs of view()"><span *ngFor="let s of segs" [ngClass]="s.cls"
          [class.lv-hl]="s.gi >= 0 && s.gi !== currentIdx()" [class.lv-cur]="s.gi >= 0 && s.gi === currentIdx()"
          [attr.data-m]="s.gi >= 0 && s.gi === currentIdx() ? s.gi : null">{{ s.text }}</span></div>
      </div>
    </div>
  `,
})
export class LogViewerComponent {
  @Input() set text(v: string) { this._text.set(v || ''); this.scheduleBottom(); }
  @Input() height = '520px';
  @ViewChild('body') bodyEl?: ElementRef<HTMLElement>;

  readonly _text = signal('');
  readonly query = signal('');
  readonly wrapOn = signal(false);
  readonly currentIdx = signal(0);

  readonly parsed = computed(() => this._text().split(/\r?\n/).map(parseAnsi));
  /** 전역 매치 목록(줄·범위), 등장 순서대로 gi 부여. */
  readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return [] as { line: number; s: number; e: number }[];
    const out: { line: number; s: number; e: number }[] = [];
    this.parsed().forEach((p, li) => {
      const hay = p.plain.toLowerCase();
      let idx = hay.indexOf(q);
      while (idx >= 0) { out.push({ line: li, s: idx, e: idx + q.length }); idx = hay.indexOf(q, idx + q.length); }
    });
    return out;
  });
  readonly matchCount = computed(() => this.matches().length);
  readonly view = computed<Seg[][]>(() => {
    const parsed = this.parsed();
    const perLine: Record<number, { s: number; e: number; gi: number }[]> = {};
    this.matches().forEach((mt, gi) => { (perLine[mt.line] ||= []).push({ s: mt.s, e: mt.e, gi }); });
    return parsed.map((p, li) => buildSegs(p, perLine[li] || []));
  });

  constructor() {
    // 현재 매치로 스크롤(검색 이동 시)
    effect(() => { const i = this.currentIdx(); this.matchCount(); queueMicrotask(() => this.scrollToCurrent(i)); });
  }

  onInput(v: string): void { this.query.set(v); this.currentIdx.set(0); }
  next(): void { const n = this.matchCount(); if (n) this.currentIdx.set((this.currentIdx() + 1) % n); }
  prev(): void { const n = this.matchCount(); if (n) this.currentIdx.set((this.currentIdx() - 1 + n) % n); }

  private scrollToCurrent(i: number): void {
    const el = this.bodyEl?.nativeElement?.querySelector('[data-m="' + i + '"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'center' });
  }
  /** 새 로그 로드 시 검색 중이 아니면 맨 아래로(tail). */
  private scheduleBottom(): void {
    queueMicrotask(() => { if (!this.query() && this.bodyEl) { const b = this.bodyEl.nativeElement; b.scrollTop = b.scrollHeight; } });
  }
}
