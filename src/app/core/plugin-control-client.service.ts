import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';

/** Control API 클라이언트 — Admin UI는 K8s를 직접 안 만지고 이것만 호출(계획서 §8).
 *  사용자 신원은 X-OpenSphere-User로 전달(audit·권한). 셸 nginx가 controller로 프록시. */
export interface CatalogItem {
  name: string; displayName: string; version: string; owner: string;
  description: string; nav?: { band: string; label: string };
  shellCompat: string; permissions: string[];
  // 위계 신호 — scope·core는 controller catalog가 이미 전송. kind·hostRef는 §2.7 확정 후 추가될 필드(있으면 트리가 정확).
  scope?: string; core?: boolean; kind?: string; hostRef?: string;
}
/** 비-UI 확장(binding) — shell 귀속 규칙의 예외 범주(콘솔 제네릭). 예: CLIDownload. */
export interface Binding { name: string; displayName?: string; kind?: string; phase?: string; }
export interface Registration {
  name: string; desiredState: string;
  status: { phase?: string; reason?: string; manifestUrl?: string; lastTransitionTime?: string };
  approval?: { requestedBy?: string; reason?: string };
}
export interface AuditEvent { time: string; actor: string; action: string; target: string; result: string; reason: string; }

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
  /** binding 목록 — best-effort(엔드포인트 없으면 빈 배열). 트리의 'Bindings' 분기에 사용. */
  async bindings(): Promise<Binding[]> {
    try {
      const r = await fetch('/api/admin/bindings', { cache: 'no-store' });
      if (!r.ok) return [];
      return (await r.json()).items || [];
    } catch {
      return [];
    }
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
}
