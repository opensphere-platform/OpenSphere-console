import { Injectable, signal } from '@angular/core';
import { HttpService } from './http.service';
import { NavigationEnd, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';

export interface R2d2GlobalRisk {
  active: number;
  severityRank: number;
  state: 'disabled' | 'unknown' | 'known' | 'degraded';
  observedAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class R2d2RiskService {
  readonly risk = signal<R2d2GlobalRisk>({ active: 0, severityRank: 0, state: 'unknown', observedAt: null });
  readonly routeIncidentCount = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;
  private events: EventSource | null = null;
  private navigation: Subscription | null = null;

  constructor(private http: HttpService, private router: Router) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    void this.refreshContext(this.router.url);
    this.navigation = this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => void this.refreshContext(event.urlAfterRedirects));
    this.timer = setInterval(() => void this.refresh(), 30_000);
    if (typeof EventSource !== 'undefined') {
      this.events = new EventSource('/api/oaa/incidents/stream', { withCredentials: true });
      const update = () => void this.refresh();
      for (const event of ['incident_detected','incident_activated','incident_severity_changed','incident_recovering','incident_resolved','incident_suspended','incident_resumed','snapshot-resync']) {
        this.events.addEventListener(event, update);
      }
      this.events.addEventListener('degraded', () => this.risk.update((value) => ({ ...value, state: 'degraded' })));
      this.events.addEventListener('authorization-revoked', () => this.stop());
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.events?.close();
    this.events = null;
    this.navigation?.unsubscribe();
    this.navigation = null;
  }

  async refresh(): Promise<void> {
    try {
      const response = await this.http.request('/api/oaa/operational/status', { cache: 'no-store' });
      if (!response.ok) {
        this.risk.set({ active: 0, severityRank: 0, state: response.status === 503 ? 'disabled' : 'degraded', observedAt: null });
        return;
      }
      const value = await response.json() as { risk?: { active?: number; severityRank?: number }; graph?: { observedAt?: string | null }; flags?: { globalRisk?: boolean } };
      this.risk.set({ active: Number(value.risk?.active || 0), severityRank: Number(value.risk?.severityRank || 0), state: value.flags?.globalRisk ? 'known' : 'disabled', observedAt: value.graph?.observedAt || null });
    } catch { this.risk.update((value) => ({ ...value, state: 'degraded' })); }
  }

  private async refreshContext(route: string): Promise<void> {
    try {
      const response = await this.http.request(`/api/oaa/context?route=${encodeURIComponent(route)}`, { cache: 'no-store' });
      if (!response.ok) { this.routeIncidentCount.set(0); return; }
      const value = await response.json() as { incidents?: unknown[] };
      this.routeIncidentCount.set(value.incidents?.length || 0);
    } catch { this.routeIncidentCount.set(0); }
  }
}
