import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';

/** Control API 클라이언트 — Admin UI는 K8s를 직접 안 만지고 이것만 호출(계획서 §8).
 *  사용자 신원은 X-OpenSphere-User로 전달(audit·권한). 셸 nginx가 controller로 프록시. */
export interface CatalogItem {
  name: string; displayName: string; version: string; owner: string;
  description: string; nav?: { band: string; label: string; icon?: string };
  shellCompat: string; permissions: string[];
  // 위계 신호 — scope·core는 controller catalog가 전송. kind·hostRef는 §2.7 확정 후 추가될 필드(있으면 트리가 정확).
  scope?: string; core?: boolean; kind?: string; hostRef?: string;
}
export interface Registration {
  name: string; desiredState: string;
  status: { phase?: string; reason?: string; manifestUrl?: string; lastTransitionTime?: string };
  approval?: { requestedBy?: string; reason?: string };
}
export interface AuditEvent { time: string; actor: string; action: string; target: string; result: string; reason: string; }
// Binding — 비-UI 콘솔 확장(CLIDownload 등). UI plugin(UIPluginPackage)과 별개 kind. 콘솔이 '선언'을 인식·노출.
export interface BindingLink { os?: string; arch?: string; text: string; href: string; }
export interface Binding { kind: string; name: string; displayName: string; description?: string; enabled?: boolean; links: BindingLink[]; }

@Injectable({ providedIn: 'root' })
export class PluginControlClient {
  private auth = inject(AuthService);

  private headers(): HeadersInit {
    return { 'content-type': 'application/json', 'X-OpenSphere-User': this.auth.user() || 'unknown' };
  }

  async catalog(): Promise<CatalogItem[]> {
    const r = await fetch('/api/admin/plugins/catalog', { cache: 'no-store' });
    if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
    return (await r.json()).items;
  }
  async registrations(): Promise<Registration[]> {
    const r = await fetch('/api/admin/plugins/registrations', { cache: 'no-store' });
    if (!r.ok) throw new Error(`registrations HTTP ${r.status}`);
    return (await r.json()).items;
  }
  async events(): Promise<AuditEvent[]> {
    const r = await fetch('/api/admin/plugins/events', { cache: 'no-store' });
    if (!r.ok) throw new Error(`events HTTP ${r.status}`);
    return (await r.json()).items;
  }
  /** headless 바인딩(CLIDownload 등) — UI plugin과 별개 채널. controller /api/admin/bindings. */
  async bindings(): Promise<Binding[]> {
    const r = await fetch('/api/admin/bindings', { cache: 'no-store' });
    if (!r.ok) throw new Error(`bindings HTTP ${r.status}`);
    return (await r.json()).items;
  }
  /** binding 소프트 토글(spec.enabled). disable=콘솔 노출만 제거(선언·서빙 유지). */
  bindingAction(name: string, action: 'enable' | 'disable') {
    return fetch(`/api/admin/bindings/${name}/${action}`, { method: 'POST', headers: this.headers() })
      .then((r) => { if (!r.ok) throw new Error(`${action} HTTP ${r.status}`); return r.json(); });
  }
  private act(id: string, action: 'install' | 'enable' | 'disable' | 'uninstall', reason?: string) {
    return fetch(`/api/admin/plugins/registrations/${id}/${action}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ reason: reason ?? '' }),
    }).then((r) => { if (!r.ok) throw new Error(`${action} HTTP ${r.status}`); return r.json(); });
  }
  install(id: string, reason?: string) { return this.act(id, 'install', reason); }
  enable(id: string) { return this.act(id, 'enable'); }
  disable(id: string) { return this.act(id, 'disable'); }
  uninstall(id: string) { return this.act(id, 'uninstall'); }
  /** 1단 아이콘 지정 — UIPluginPackage spec.nav.icon 패치(Carbon 토큰명). 빈 문자열=기본 아이콘. */
  setIcon(id: string, icon: string) {
    return fetch(`/api/admin/plugins/packages/${id}/icon`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ icon }),
    }).then((r) => { if (!r.ok) throw new Error(`set-icon HTTP ${r.status}`); return r.json(); });
  }
}
