import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

/** 헌법 §6 + D-B: 2+1 Workspace. 셸은 1벌, perspective는 그 위 투영(lens). */
export interface Workspace {
  id: 'A' | 'B' | 'C' | 'D';
  label: string;       // 사용자 표시(운영/협업/업무)
  desc: string;        // 부제(Console/Workplace/Business)
  bands: string[];     // 이 워크스페이스가 포함하는 nav 밴드(기존 밴드 흡수)
}

export const WORKSPACES: Workspace[] = [
  { id: 'A', label: '운영', desc: 'Console · 운영/관리', bands: ['운영 Operate'] },
  { id: 'B', label: '협업', desc: 'Workplace · 개발/협업', bands: ['구축 Build'] },
  { id: 'C', label: '업무', desc: 'Business · ERP/업무', bands: ['전달 Deliver'] },
  { id: 'D', label: '지능', desc: 'Intelligence · AI', bands: ['지능 Intelligence'] },
];

const LS_KEY = 'os.activeWorkspace';

/**
 * Perspective(Workspace) 정책 + 활성 상태.
 * 정책 게이트는 현재 토큰 그룹/역할 기반(OPA-ready) — 실제 OPA 서비스 질의는 다음 단계.
 * decide()를 OPA 호출로 교체하면 됨(seam 명시).
 */
@Injectable({ providedIn: 'root' })
export class PerspectiveService {
  private auth = inject(AuthService);

  readonly all = WORKSPACES;

  /** 정책 결정: 역할/그룹 → 허용 워크스페이스 id 집합.
   *  ⚠️ PoC: 셸 내 정책. 운영 전 OPA(rego)로 이관 — 이 함수가 그 seam이다. */
  private decide(groups: string[], roles: string[]): Array<Workspace['id']> {
    // `console-admins` is the canonical Supabase Console role.  The two
    // legacy names remain accepted only while older identity projections are
    // being retired.
    const isAdmin =
      groups.includes('console-admins') ||
      groups.includes('opensphere-console-admins') ||
      groups.includes('platform-admins') ||
      roles.includes('console-admins') ||
      roles.includes('platform-admin');
    if (isAdmin) return ['A', 'B', 'C', 'D'];     // 운영자: 전 워크스페이스(지능 포함)
    return ['B', 'C'];                            // 일반: 운영(A) 제외, 협업·업무만
  }

  readonly allowed = computed<Array<Workspace['id']>>(() =>
    this.decide(this.auth.groups(), this.auth.roles()));

  readonly allowedWorkspaces = computed<Workspace[]>(() =>
    this.all.filter((w) => this.allowed().includes(w.id)));

  /** 콘솔 관리자(운영 워크스페이스 A 접근 가능) — 헤더 admin 링크·운영 밴드 가시성 게이트 */
  readonly isAdmin = computed<boolean>(() => this.allowed().includes('A'));

  private readonly _active = signal<Workspace['id']>(this.restore());

  /** 정책상 허용된 워크스페이스만 활성으로 보정 */
  readonly active = computed<Workspace['id']>(() => {
    const a = this._active();
    const allowed = this.allowed();
    return allowed.includes(a) ? a : (allowed[0] ?? 'A');
  });

  readonly activeWorkspace = computed<Workspace>(() =>
    this.all.find((w) => w.id === this.active()) ?? this.all[0]);

  setActive(id: Workspace['id']): void {
    if (!this.allowed().includes(id)) return;     // 정책 위반 전환 차단
    this._active.set(id);
    try { localStorage.setItem(LS_KEY, id); } catch { /* ignore */ }
  }

  /** nav 밴드가 현재 활성 워크스페이스에 속하는가 */
  bandInActive(band: string): boolean {
    return this.activeWorkspace().bands.includes(band);
  }

  private restore(): Workspace['id'] {
    try {
      const v = localStorage.getItem(LS_KEY) as Workspace['id'] | null;
      if (v === 'A' || v === 'B' || v === 'C' || v === 'D') return v;
    } catch { /* ignore */ }
    return 'A';
  }
}
