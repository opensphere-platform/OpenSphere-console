import { Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { K8sService } from '../core/k8s.service';

/** Pod exec 터미널 — 백엔드 WS 게이트웨이(/api/k8s-exec)에 K8s 채널(v4.channel.k8s.io) 프레이밍으로 연결.
 *  채널 0=stdin, 1=stdout, 2=stderr, 3=error, 4=resize. 인증은 세션 쿠키(백엔드 JWKS 검증→임퍼소네이션). */
@Component({
  selector: 'app-terminal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>
    <div class="os-term" #term></div>
  `,
})
export class TerminalComponent implements OnInit, OnDestroy {
  @Input({ required: true }) ns!: string;
  @Input({ required: true }) pod!: string;
  @Input() container = '';
  @Input() command = '/bin/sh';
  @ViewChild('term', { static: true }) termEl!: ElementRef<HTMLElement>;

  private k8s = inject(K8sService);
  readonly error = signal<string | null>(null);
  private term?: Terminal;
  private fit?: FitAddon;
  private ws?: WebSocket;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  private onWinResize = () => this.doFit();
  // 컨테이너(.os-term) 세로 리사이즈 시 xterm 격자 재계산(fit) — 창 크기 조절 대응
  private ro?: ResizeObserver;

  ngOnInit(): void {
    // 먼저 세션 쿠키 발급(브라우저 WS가 토큰을 헤더로 못 싣기 때문) → 성공 시 WS 연결
    this.k8s.session().subscribe({
      next: () => this.connect(),
      error: e => this.error.set('세션 발급 실패: ' + (e?.error?.error || e?.message || e)),
    });
  }

  private connect(): void {
    const base = ((window as any).__OSP_NG_API_BASE__ || '').replace(/\/$/, '');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${base}/api/k8s-exec/${encodeURIComponent(this.ns)}/${encodeURIComponent(this.pod)}` +
      `?container=${encodeURIComponent(this.container)}&command=${encodeURIComponent(this.command)}`;

    this.term = new Terminal({ convertEol: true, fontSize: 12, cursorBlink: true, theme: { background: '#1b2b34', foreground: '#d6e2e8' } });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.termEl.nativeElement);
    setTimeout(() => this.doFit(), 0);

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.term!.focus(); this.sendResize(); };
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      if (!b.length) return;
      const ch = b[0];
      const data = this.dec.decode(b.subarray(1));
      if (ch === 1 || ch === 2) this.term!.write(data);
      else if (ch === 3) this.term!.write('\r\n\x1b[31m[exec] ' + data + '\x1b[0m\r\n');
    };
    ws.onclose = () => this.term?.write('\r\n\x1b[90m[연결 종료]\x1b[0m\r\n');
    ws.onerror = () => this.error.set('WS 연결 오류');

    this.term.onData((d) => this.sendChannel(0, this.enc.encode(d)));
    this.term.onResize(() => this.sendResize());
    window.addEventListener('resize', this.onWinResize);
    // 컨테이너 세로 드래그 리사이즈 → xterm 격자 재계산 + 백엔드 pty resize
    this.ro = new ResizeObserver(() => this.doFit());
    this.ro.observe(this.termEl.nativeElement);
  }

  private sendChannel(ch: number, payload: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = ch;
    frame.set(payload, 1);
    this.ws.send(frame);
  }
  private sendResize(): void {
    if (!this.term) return;
    this.sendChannel(4, this.enc.encode(JSON.stringify({ Width: this.term.cols, Height: this.term.rows })));
  }
  private doFit(): void { try { this.fit?.fit(); } catch { /* noop */ } }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onWinResize);
    try { this.ro?.disconnect(); } catch { /* noop */ }
    try { this.ws?.close(); } catch { /* noop */ }
    try { this.term?.dispose(); } catch { /* noop */ }
  }
}
