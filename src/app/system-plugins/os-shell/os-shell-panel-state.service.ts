import { Injectable, signal } from '@angular/core';

/** Host-owned presentation state for the OCI-style docked OS Shell panel. */
@Injectable({ providedIn: 'root' })
export class OsShellPanelStateService {
  readonly open = signal(false);
  readonly expanded = signal(false);

  toggle(): void {
    this.open.update((value) => !value);
  }

  close(): void {
    this.open.set(false);
    this.expanded.set(false);
  }

  toggleExpanded(): void {
    this.expanded.update((value) => !value);
  }
}
