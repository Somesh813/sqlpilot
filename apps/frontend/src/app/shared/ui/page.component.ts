import { Component, input } from '@angular/core';

@Component({
  selector: 'sp-page',
  standalone: true,
  template: `
    <div class="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8">
      <header class="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-xl font-semibold text-content-strong">{{ title() }}</h1>
          @if (subtitle()) {
            <p class="mt-1 text-sm text-content-muted">{{ subtitle() }}</p>
          }
        </div>
        <div class="flex items-center gap-2">
          <ng-content select="[actions]" />
        </div>
      </header>
      <ng-content />
    </div>
  `,
})
export class PageComponent {
  readonly title = input.required<string>();
  readonly subtitle = input('');
}
