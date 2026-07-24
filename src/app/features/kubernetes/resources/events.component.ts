import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** involvedObject → "Kind/name". */
const involved = (o: any) => `${o.involvedObject?.kind || ''}/${o.involvedObject?.name || ''}`;

/** Events 목록 — /api/v1/events. namespaced. Type(Normal/Warning) 패싯 자동(kind:status). */
@Component({
  selector: 'app-res-events',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Events" path="/api/v1/events" [namespaced]="true" kind="Event" [columns]="cols" />`,
})
export class EventComponent {
  cols: ColumnDef[] = [
    { id: 'reason', label: 'Reason', kind: 'name', get: o => o.reason },
    { id: 'type', label: 'Type', kind: 'status', get: o => o.type || 'Normal', statusOf: o => (o.type === 'Warning' ? 'warning' : 'info') },
    { id: 'object', label: 'Object', get: o => involved(o) },
    { id: 'message', label: 'Message', get: o => o.message },
    { id: 'count', label: 'Count', get: o => o.count ?? 1 },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.lastTimestamp || o.eventTime || o.metadata?.creationTimestamp },
  ];
}
