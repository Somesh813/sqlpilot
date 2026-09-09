import { Component, inject } from '@angular/core';
import { ThemeService } from '../../core/services/theme.service';

@Component({
  selector: 'sp-theme-toggle',
  standalone: true,
  template: `
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-xl border border-surface-border bg-surface-0 text-content hover:bg-surface-2"
      [attr.aria-label]="theme.mode() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
      (click)="theme.toggle()"
    >
      {{ theme.mode() === 'dark' ? '☀' : '☾' }}
    </button>
  `,
})
export class ThemeToggleComponent {
  readonly theme = inject(ThemeService);
}
