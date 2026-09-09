import { Component, input } from '@angular/core';

@Component({
  selector: 'sp-empty-state',
  standalone: true,
  template: `
    <div class="sp-card flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div class="grid h-12 w-12 place-items-center rounded-2xl border border-surface-border bg-surface-2 text-xl">
        {{ icon() }}
      </div>
      <h3 class="text-base font-semibold text-content-strong">{{ title() }}</h3>
      <p class="max-w-sm text-sm text-content-muted">{{ description() }}</p>
      <ng-content />
    </div>
  `,
})
export class EmptyStateComponent {
  readonly icon = input('◦');
  readonly title = input.required<string>();
  readonly description = input('');
}
