import { Injectable, computed, inject, signal } from '@angular/core';
import { PluginControlClient } from './plugin-control-client.service';
import { mergeNotifications } from './notification.merge';

export type OsSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * 셸 단일 인박스 알림 모델 (single control point).
 * 규범: P6-experience §1("셸 1벌이 단일 알림 인박스 통합") + 헌법 §6.0(audit bus = "P0 소유,
 * 각 perspective/플러그인이 발행"). 콘솔 알림 백본 = 콘솔-네이티브 audit bus(Novu 아님 — Novu는
 * 워크스페이스 전용). 상세: ADR-UI-002 / dupa-notification-contribution-contract.
 */
export interface OsNotification {
  id: string;
  source: string; // 셸이 강제 태깅: pluginId | 'dupa-audit' | 'k8s' | 'alertmanager'
  severity: OsSeverity;
  category?: string; // 'plugin-lifecycle' | 'slo' | 'task' ...
  title: string;
  detail?: string;
  route?: string; // 클릭 시 이동(/p/<id>/<route>)
  topic?: string; // 그룹핑
  dedupKey?: string; // 동일 알림 갱신(스팸 억제)
  persistent: boolean; // true=인박스 적재 / false=토스트(일시)
  time: string;
  read: boolean;
  actions?: { label: string; route?: string }[];
}

/** 발행 입력 — id·source·read는 셸이 채운다(time은 생략 시 now) */
export type NotifyInput = Omit<OsNotification, 'id' | 'source' | 'time' | 'read'> & { time?: string };

const LS_SEEN = 'os.notif.seen';
const AUDIT_SOURCE = 'dupa-audit';
const INPROC = 'inproc';
const TOAST_TTL_MS = 6000;

/**
 * 셸 레벨 알림 인박스. 소스(멀티):
 *   - 'dupa-audit'    : DUPA 컨트롤러 audit 폴링(install/enable/disable) — 콘솔-네이티브, 현행.
 *   - 'inproc'        : subShell in-page 발행(ctx.notify.publish) — 같은 JS 컨텍스트.
 *   - 'k8s'/'alertmanager' 등 : 향후 mergeSource로 합류(OKD 렌즈).
 * ⚠️ Novu는 워크스페이스(사원) 전용 — 콘솔 인박스 소스 아님(ADR-UI-002 D1).
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private control = inject(PluginControlClient);

  /** 영구 알림 소스별 보관 — recompute()가 flatten·dedup·정렬한다. */
  private sources = new Map<string, OsNotification[]>();

  /** 인박스(영구) */
  readonly items = signal<OsNotification[]>([]);
  /** 토스트(일시, 자동 소멸) */
  readonly toasts = signal<OsNotification[]>([]);
  readonly unread = computed<number>(() => this.items().filter((n) => !n.read).length);

  private seen = new Set<string>(this.restoreSeen());
  private timer?: ReturnType<typeof setInterval>;
  private seq = 0;

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 20000);
  }

  /** DUPA 컨트롤러 audit 폴링 → 'dupa-audit' 소스로 합산(콘솔-네이티브). */
  async refresh(): Promise<void> {
    try {
      const events = await this.control.events();
      // 컨트롤러 audit bus는 멀티소스: 플러그인 lifecycle + subShell 백엔드 발행(P1) + (향후 K8s/Alertmanager).
      // action으로 분기 — lifecycle만 'dupa-audit'·"플러그인 X", 그 외는 발행 source 그대로.
      const LIFECYCLE = new Set(['install', 'enable', 'disable', 'uninstall']);
      const items: OsNotification[] = events.map((e) => {
        const id = `${AUDIT_SOURCE}|${e.time}|${e.action}|${e.target}`;
        const lifecycle = LIFECYCLE.has(e.action);
        return {
          id,
          source: lifecycle ? AUDIT_SOURCE : e.actor || 'event',
          severity: this.severityOf(e.result),
          category: lifecycle ? 'plugin-lifecycle' : 'event',
          persistent: true,
          time: e.time,
          title: lifecycle ? `플러그인 ${e.action} — ${e.target}` : `${e.action} — ${e.target}`,
          detail: `${e.actor} · ${e.result}${e.reason ? ' · ' + e.reason : ''}`,
          read: this.seen.has(id),
        };
      });
      this.mergeSource(AUDIT_SOURCE, items);
    } catch {
      /* 소스 불가 시 조용히 유지 */
    }
  }

  /** 폴링/구독 소스용 — 해당 소스 전체 교체 후 재합성(idempotent). */
  mergeSource(key: string, items: OsNotification[]): void {
    this.sources.set(key, items);
    this.recompute();
  }

  /**
   * in-proc 발행 — ctx.notify.publish(셸이 source 태깅 완료) → 여기.
   * persistent=false는 토스트 큐로, true는 인박스('inproc' 버킷, dedupKey로 갱신).
   */
  push(n: OsNotification): void {
    if (!n.persistent) {
      this.enqueueToast(n);
      return;
    }
    const bucket = this.sources.get(INPROC) ?? [];
    const next = n.dedupKey
      ? [...bucket.filter((x) => !(x.source === n.source && x.dedupKey === n.dedupKey)), n]
      : [...bucket, n];
    this.sources.set(INPROC, next);
    this.recompute();
  }

  /** 특정 발행자(plugin) 알림 정리 — ctx.notify.clear / 언마운트 시 셸이 호출. */
  clearSource(source: string): void {
    let changed = false;
    for (const [key, list] of this.sources) {
      const filtered = list.filter((n) => n.source !== source);
      if (filtered.length !== list.length) {
        this.sources.set(key, filtered);
        changed = true;
      }
    }
    this.toasts.update((t) => t.filter((n) => n.source !== source));
    if (changed) this.recompute();
  }

  /** 발행자 자기 알림만 닫기(타 발행자 것 못 닫음). */
  dismissById(source: string, id: string): void {
    const bucket = this.sources.get(INPROC) ?? [];
    const next = bucket.filter((n) => !(n.id === id && n.source === source));
    if (next.length !== bucket.length) {
      this.sources.set(INPROC, next);
      this.recompute();
    }
    this.toasts.update((t) => t.filter((n) => !(n.id === id && n.source === source)));
  }

  markAllRead(): void {
    for (const n of this.items()) this.seen.add(n.id);
    this.persistSeen();
    this.recompute();
  }

  dismissToast(id: string): void {
    this.toasts.update((t) => t.filter((n) => n.id !== id));
  }

  /** 발행자(host)용 안정 id — source|epoch|seq. */
  nextId(source: string): string {
    return `${source}|${Date.now()}|${this.seq++}`;
  }

  /** 전 소스 flatten → dedupKey 최신 우선 → time desc → read 반영 (순수 로직: notification.merge). */
  private recompute(): void {
    this.items.set(mergeNotifications([...this.sources.values()], this.seen));
  }

  private enqueueToast(n: OsNotification): void {
    this.toasts.update((t) => [...t, n]);
    setTimeout(() => this.toasts.update((t) => t.filter((x) => x.id !== n.id)), TOAST_TTL_MS);
  }

  private severityOf(result: string): OsSeverity {
    if (/fail|error|deny|거부|실패/i.test(result)) return 'error';
    if (/warn|경고/i.test(result)) return 'warning';
    if (/success|accepted|ok|성공|완료/i.test(result)) return 'success';
    return 'info';
  }

  private restoreSeen(): string[] {
    try {
      return JSON.parse(localStorage.getItem(LS_SEEN) ?? '[]');
    } catch {
      return [];
    }
  }
  private persistSeen(): void {
    try {
      localStorage.setItem(LS_SEEN, JSON.stringify([...this.seen].slice(-200)));
    } catch {
      /* ignore */
    }
  }
}
