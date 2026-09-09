import { Component, input } from '@angular/core';
import { PageComponent } from './page.component';
import { EmptyStateComponent } from './empty-state.component';

@Component({
  selector: 'sp-coming-soon',
  standalone: true,
  imports: [PageComponent, EmptyStateComponent],
  template: `
    <sp-page [title]="title()">
      <sp-empty-state icon="⚑" [title]="title() + ' is coming next'" [description]="phase()" />
    </sp-page>
  `,
})
export class ComingSoonComponent {
  readonly title = input.required<string>();
  readonly phase = input('This area is scaffolded and will be built in an upcoming phase.');
}
