import { Component } from '@angular/core';
import { ComingSoonComponent } from '../shared/ui/coming-soon.component';

@Component({
  selector: 'sp-connections',
  standalone: true,
  imports: [ComingSoonComponent],
  template: `<sp-coming-soon title="Connections" phase="Phase 3 — add, test, and manage PostgreSQL, MySQL, and SQLite connections." />`,
})
export class ConnectionsComponent {}
