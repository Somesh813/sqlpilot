import { Component } from '@angular/core';
import { ComingSoonComponent } from '../shared/ui/coming-soon.component';

@Component({
  selector: 'sp-query-history',
  standalone: true,
  imports: [ComingSoonComponent],
  template: `<sp-coming-soon title="Query History" phase="Phase 8 — searchable, filterable history of every prompt, generated SQL, and execution result." />`,
})
export class QueryHistoryComponent {}
