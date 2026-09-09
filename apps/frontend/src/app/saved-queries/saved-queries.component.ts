import { Component } from '@angular/core';
import { ComingSoonComponent } from '../shared/ui/coming-soon.component';

@Component({
  selector: 'sp-saved-queries',
  standalone: true,
  imports: [ComingSoonComponent],
  template: `<sp-coming-soon title="Saved Queries" phase="Phase 8 — save, tag, search, and re-run your favorite queries." />`,
})
export class SavedQueriesComponent {}
