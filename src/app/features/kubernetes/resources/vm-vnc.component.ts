import { Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import RFB from '@novnc/novnc';
import { K8sService } from '../core/k8s.service';

/**
 * VM VNC(그래픽) 콘솔 — noVNC RFB를 virt-api vnc 서브리소스 WS 게이트웨이(/api/k8s-vmvnc/<ns>/<name>)에 연결.
 * OpenShift Virtualization 콘솔 패턴(noVNC ← vnc subresource)과 동일. 인증=세션 쿠키.
 */
@Component({
  selector: 'app-vm-vnc',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    .vm-vnc-bar { display: flex; align-items: center; gap: .75rem; padding: .25rem 0 .5rem; }
    .vm-vnc-screen { width: 100%; height: 540px; background: #000; border-radius: 4px; overflow: hidden; }
  `],
  template: `
    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>
    <div class="vm-vnc-bar">
      <span class="label" [ngClass]="connected() ? 'label-success' : 'label-info'">{{ status() }}</span>
      <button class="btn btn-sm btn-outline" (click)="reconnect()">재연결</button>
      <button class="btn btn-sm btn-link" (click)="sendCtrlAltDel()" [disabled]="!connected()">Ctrl+Alt+Del</button>
    </div>
    <div class="vm-vnc-screen" #screen></div>
  `,
})
export class VmVncComponent implements OnInit, OnDestroy {
  @Input({ required: true }) ns!: string;
  @Input({ required: true }) name!: string;
  @ViewChild('screen', { static: true }) screenEl!: ElementRef<HTMLElement>;

  private k8s = inject(K8sService);
  readonly error = signal<string | null>(null);
  readonly status = signal('연결 중…');
  readonly connected = signal(false);
  private rfb: any;

  ngOnInit(): void {
    this.k8s.session().subscribe({
      next: () => this.connect(),
      error: e => this.error.set('세션 발급 실패: ' + (e?.error?.error || e?.message || e)),
    });
  }

  private base(): string {
    const w = window as any;
    return String(w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '').replace(/\/$/, '');
  }

  private connect(): void {
    this.error.set(null);
    this.status.set('연결 중…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${this.base()}/api/k8s-vmvnc/${encodeURIComponent(this.ns)}/${encodeURIComponent(this.name)}`;
    try {
      this.rfb = new RFB(this.screenEl.nativeElement, url, {});
      this.rfb.scaleViewport = true;
      this.rfb.clipViewport = false;
      this.rfb.background = '#000';
      this.rfb.addEventListener('connect', () => { this.connected.set(true); this.status.set('연결됨'); });
      this.rfb.addEventListener('disconnect', (e: any) => { this.connected.set(false); this.status.set(e?.detail?.clean ? '연결 종료' : '연결 끊김(오류)'); });
      this.rfb.addEventListener('securityfailure', (e: any) => this.error.set('VNC 보안 실패: ' + (e?.detail?.reason || '')));
    } catch (e: any) {
      this.error.set('VNC 초기화 실패: ' + (e?.message || e));
    }
  }

  reconnect(): void { try { this.rfb?.disconnect(); } catch { /* noop */ } this.connect(); }
  sendCtrlAltDel(): void { try { this.rfb?.sendCtrlAltDel(); } catch { /* noop */ } }

  ngOnDestroy(): void { try { this.rfb?.disconnect(); } catch { /* noop */ } }
}
