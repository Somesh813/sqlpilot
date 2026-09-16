import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { SavedQuery } from '@sqlpilot/shared';
import { ToastService } from '../core/services/toast.service';
import { EmptyStateComponent } from '../shared/ui/empty-state.component';
import { PageComponent } from '../shared/ui/page.component';
import { SavedQueriesApiService } from './saved-queries.service';

@Component({
  selector: 'sp-saved-queries',
  standalone: true,
  imports: [PageComponent, EmptyStateComponent, FormsModule],
  template: `
    <sp-page title="Saved Queries" subtitle="Your favorite queries, ready to re-run.">
      <input
        actions
        class="sp-input w-56 py-1.5 text-sm"
        placeholder="Search saved queries…"
        [ngModel]="search()"
        (ngModelChange)="onSearch($event)"
      />

      @if (loading()) {
        <div class="sp-card p-8 text-center text-sm text-content-muted">Loading…</div>
      } @else if (items().length === 0) {
        <sp-empty-state
          icon="★"
          title="No saved queries yet"
          description="Save a query from the AI assistant workspace to find it here."
        >
          <button class="sp-btn-primary mt-2" (click)="router.navigate(['/assistant'])">Open assistant</button>
        </sp-empty-state>
      } @else {
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          @for (q of items(); track q.id) {
            <div class="sp-card flex flex-col gap-2 p-4">
              <p class="font-medium text-content-strong">{{ q.name }}</p>
              @if (q.description) {
                <p class="text-xs text-content-muted">{{ q.description }}</p>
              }
              <pre class="max-h-24 overflow-hidden truncate whitespace-pre-wrap rounded-lg bg-surface-1 p-2 font-mono text-xs text-content">{{ q.sql }}</pre>
              @if (q.tags.length) {
                <div class="flex flex-wrap gap-1">
                  @for (t of q.tags; track t) {
                    <span class="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-content-muted">{{ t }}</span>
                  }
                </div>
              }
              <div class="mt-auto flex gap-2 pt-1">
                <button class="sp-btn-ghost px-2.5 py-1 text-xs" (click)="run(q)">Run</button>
                <button class="sp-btn-ghost px-2.5 py-1 text-xs" (click)="duplicate(q)">Duplicate</button>
                <button class="sp-btn-ghost px-2.5 py-1 text-xs text-red-500" (click)="remove(q)">Delete</button>
              </div>
            </div>
          }
        </div>
      }
    </sp-page>
  `,
})
export class SavedQueriesComponent implements OnInit {
  private readonly api = inject(SavedQueriesApiService);
  private readonly toast = inject(ToastService);
  readonly router = inject(Router);

  readonly items = signal<SavedQuery[]>([]);
  readonly loading = signal(false);
  readonly search = signal('');
  private debounce?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    this.fetch();
  }

  onSearch(v: string): void {
    this.search.set(v);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.fetch(), 300);
  }

  private fetch(): void {
    this.loading.set(true);
    this.api.list(this.search() || undefined).subscribe({
      next: (items) => {
        this.items.set(items);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  run(q: SavedQuery): void {
    sessionStorage.setItem('sqlpilot.pendingSql', q.sql);
    this.router.navigate(['/assistant'], {
      queryParams: q.connectionId ? { connectionId: q.connectionId } : {},
    });
  }

  duplicate(q: SavedQuery): void {
    sessionStorage.setItem('sqlpilot.pendingSql', q.sql);
    this.router.navigate(['/assistant']);
  }

  remove(q: SavedQuery): void {
    if (!confirm(`Delete "${q.name}"?`)) return;
    this.api.remove(q.id).subscribe({
      next: () => {
        this.toast.success('Saved query deleted');
        this.fetch();
      },
    });
  }
}
