import { Component } from '@angular/core';
import { ComingSoonComponent } from '../shared/ui/coming-soon.component';

@Component({
  selector: 'sp-assistant',
  standalone: true,
  imports: [ComingSoonComponent],
  template: `<sp-coming-soon title="AI Assistant" phase="Phase 6 — chat-style natural-language to SQL with schema-aware generation, editing, and safe execution." />`,
})
export class AssistantComponent {}
