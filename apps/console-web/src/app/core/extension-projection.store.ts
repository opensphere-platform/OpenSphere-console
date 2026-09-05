import { Injectable, inject, signal, computed } from '@angular/core';
import {
  CatalogItem,
  ExtensionProjectionStatus,
  PluginControlClient,
  Registration,
} from './plugin-control-client.service';

export interface ExtensionProjectionRefreshResult {
  catalogAvailable: boolean;
  registrationsAvailable: boolean;
  issues: readonly ('Catalog' | 'Registration')[];
}

/**
 * Document-scoped owner of the two composition projections used by both the
 * Main Shell and Extension management. It deduplicates in-flight reads and
 * preserves the last valid values when the Control API is temporarily down.
 */
@Injectable({ providedIn: 'root' })
export class ExtensionProjectionStore {
  private readonly control = inject(PluginControlClient);
  private inFlight: Promise<ExtensionProjectionRefreshResult> | null = null;
  private forcedAfterInFlight: Promise<ExtensionProjectionRefreshResult> | null = null;

  readonly catalog = signal<CatalogItem[]>([]);
  readonly registrations = signal<Registration[]>([]);
  readonly catalogLoaded = signal(false);
  readonly registrationsLoaded = signal(false);
  readonly catalogProjection = signal<ExtensionProjectionStatus | null>(null);
  readonly registrationProjection = signal<ExtensionProjectionStatus | null>(null);
  readonly projectionStatus = computed<ExtensionProjectionStatus | null>(() => {
    const values=[this.catalogProjection(),this.registrationProjection()];
    if(values.every(v=>!v))return null;
    const state=values.every(v=>v?.state==='live'&&v.ready)?'live':values.some(v=>v?.observedAt)?'stale':'unavailable';
    const observedAt=values.map(v=>v?.observedAt).filter((v):v is string=>!!v).sort()[0];
    return {ready:state==='live',state,observedAt,reason:state==='live'?undefined:'ProjectionReadIncomplete'};
  });

  refresh(force = false): Promise<ExtensionProjectionRefreshResult> {
    // A manual refresh starts new I/O only after the current read settles.
    // `force` means "do not reuse settled state", never "duplicate in-flight".
    if (this.inFlight) {
      if (!force) return this.inFlight;
      if (!this.forcedAfterInFlight) {
        const active = this.inFlight;
        const queued = active
          .catch(() => null)
          .then(() => this.refresh(true));
        let forced!: Promise<ExtensionProjectionRefreshResult>;
        forced = queued.finally(() => {
          if (this.forcedAfterInFlight === forced) this.forcedAfterInFlight = null;
        });
        this.forcedAfterInFlight = forced;
      }
      return this.forcedAfterInFlight;
    }
    if (!force && this.catalogLoaded() && this.registrationsLoaded()
        && this.catalogProjection()?.ready && this.registrationProjection()?.ready) {
      return Promise.resolve({ catalogAvailable: true, registrationsAvailable: true, issues: [] });
    }
    const pending = this.performRefresh();
    this.inFlight = pending;
    return pending.finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
  }

  private async performRefresh(): Promise<ExtensionProjectionRefreshResult> {
    const [catalog, registrations] = await Promise.allSettled([
      this.control.catalogSnapshot(),
      this.control.registrationsSnapshot(),
    ]);
    const issues: Array<'Catalog' | 'Registration'> = [];
    if (catalog.status === 'fulfilled') {
      this.catalog.set(catalog.value.items);
      this.catalogLoaded.set(true);
      this.catalogProjection.set(catalog.value.projection);
    } else { issues.push('Catalog'); this.catalogProjection.set({...this.catalogProjection(), ready:false, state:this.catalogLoaded()?'stale':'unavailable',reason:'CatalogReadFailed'}); }
    if (registrations.status === 'fulfilled') {
      this.registrations.set(registrations.value.items);
      this.registrationsLoaded.set(true);
      this.registrationProjection.set(registrations.value.projection);
    } else { issues.push('Registration'); this.registrationProjection.set({...this.registrationProjection(), ready:false, state:this.registrationsLoaded()?'stale':'unavailable',reason:'RegistrationReadFailed'}); }
    return {
      catalogAvailable: this.catalogLoaded(),
      registrationsAvailable: this.registrationsLoaded(),
      issues,
    };
  }
}
