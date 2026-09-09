import { Component, inject } from '@angular/core';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'sp-toast-container',
  standalone: true,
  template: `
    <div class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      @for (toast of toasts.toasts(); track toast.id) {
        <div
          class="pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg"
          [class]="styles(toast.kind)"
        >
          <span class="mt-0.5">{{ icon(toast.kind) }}</span>
          <p class="flex-1 leading-snug">{{ toast.message }}</p>
          <button class="text-content-muted hover:text-content-strong" (click)="toasts.dismiss(toast.id)">✕</button>
        </div>
      }
    </div>
  `,
})
export class ToastContainerComponent {
  readonly toasts = inject(ToastService);

  styles(kind: string): string {
    switch (kind) {
      case 'success':
        return 'bg-surface-1 border-emerald-500/40 text-content-strong';
      case 'error':
        return 'bg-surface-1 border-red-500/40 text-content-strong';
      default:
        return 'bg-surface-1 border-surface-border text-content-strong';
    }
  }

  icon(kind: string): string {
    return kind === 'success' ? '✓' : kind === 'error' ? '⚠' : 'ℹ';
  }
}
