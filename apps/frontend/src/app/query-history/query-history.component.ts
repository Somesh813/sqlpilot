import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { Paginated, QueryHistoryEntry } from '@sqlpilot/shared';
import { ToastService } from '../core/services/toast.service';
import { EmptyStateComponent } from '../shared/ui/empty-state.component';
import { PageComponent } from '../shared/ui/page.component';
import { QueryHistoryApiService } from './query-history.service';

@Component({
  selector: 'sp-query-history',
  standalone: true,
  imports: [PageComponent, EmptyStateComponent, FormsModule, DatePipe],
  template: `
    <sp-page title="Query History" subtitle="Every prompt, generated SQL, and execution result.">
      <div actions class="flex gap-2">
        <input
          class="sp-input w-56 py-1.5 text-sm"
          placeholder="Search SQL or prompt…"
          [ngModel]="search()"
          (ngModelChange)="onSearch($event)"
        />
        <select class="sp-input w-36 py-1.5 text-sm" [ngModel]="status()" (ngModelChange)="onStatus($event)">
          <option value="">All statuses</option>
          <option value="SUCCESS">Success</option>
          <option value="ERROR">Error</option>
          <option value="BLOCKED">Blocked</option>
          <option value="TIMEOUT">Timeout</option>
        </select>
      </div>

      @if (loading()) {
        <div class="sp-card p-8 text-center text-sm text-content-muted">Loading…</div>
      } @else {
      @if (page(); as p) {
        @if (p.items.length === 0) {
          <sp-empty-state
            icon="↺"
            title="Your query history will appear here"
            description="Run a query from the assistant to see it show up here."
          />
        } @else {
        <div class="sp-card divide-y divide-surface-border">
          @for (entry of p.items; track entry.id) {
            <div class="flex items-start justify-between gap-4 p-4">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="rounded-full px-2 py-0.5 text-[11px] font-medium" [class]="badge(entry.status)">
                    {{ entry.status }}
                  </span>
                  <span class="text-xs text-content-muted">{{ entry.connectionName }}</span>
                  @if (entry.aiGenerated) {
                    <span class="text-xs text-brand-500">✦ AI</span>
                  }
                  <span class="text-xs text-content-muted">{{ entry.createdAt | date: 'short' }}</span>
                </div>
                @if (entry.prompt) {
                  <p class="mt-1 truncate text-sm text-content-strong">{{ entry.prompt }}</p>
                }
                <pre class="mt-1 truncate whitespace-pre-wrap font-mono text-xs text-content-muted">{{ entry.sql }}</pre>
                @if (entry.error) {
                  <p class="mt-1 text-xs text-red-500">{{ entry.error }}</p>
                }
                <p class="mt-1 text-xs text-content-muted">
                  @if (entry.executionTimeMs !== null) { {{ entry.executionTimeMs }} ms · }
                  @if (entry.rowCount !== null) { {{ entry.rowCount }} rows }
                </p>
              </div>
              <div class="flex shrink-0 flex-col gap-1">
                <button class="sp-btn-ghost px-2.5 py-1 text-xs" (click)="openInWorkspace(entry)">Open</button>
                <button class="sp-btn-ghost px-2.5 py-1 text-xs text-red-500" (click)="remove(entry)">Delete</button>
              </div>
            </div>
          }
        </div>

        <div class="mt-3 flex items-center justify-between text-xs text-content-muted">
          <button class="sp-btn-ghost px-2.5 py-1" [disabled]="pageNum() <= 1" (click)="setPage(pageNum() - 1)">
            Prev
          </button>
          <span>Page {{ p.page }} · {{ p.total }} total</span>
          <button
            class="sp-btn-ghost px-2.5 py-1"
            [disabled]="p.page * p.pageSize >= p.total"
            (click)="setPage(pageNum() + 1)"
          >
            Next
          </button>
        </div>
        }
      }
      }
    </sp-page>
  `,
})
export class QueryHistoryComponent implements OnInit {
  private readonly api = inject(QueryHistoryApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly page = signal<Paginated<QueryHistoryEntry> | null>(null);
  readonly loading = signal(false);
  readonly search = signal('');
  readonly status = signal('');
  readonly pageNum = signal(1);

  private searchDebounce?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    this.fetch();
  }

  onSearch(value: string): void {
    this.search.set(value);
    clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.pageNum.set(1);
      this.fetch();
    }, 300);
  }

  onStatus(value: string): void {
    this.status.set(value);
    this.pageNum.set(1);
    this.fetch();
  }

  setPage(n: number): void {
    this.pageNum.set(n);
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.api
      .list({
        page: this.pageNum(),
        search: this.search() || undefined,
        status: (this.status() || undefined) as never,
      })
      .subscribe({
        next: (p) => {
          this.page.set(p);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  remove(entry: QueryHistoryEntry): void {
    this.api.remove(entry.id).subscribe({
      next: () => {
        this.toast.success('Removed from history');
        this.fetch();
      },
    });
  }

  openInWorkspace(entry: QueryHistoryEntry): void {
    this.router.navigate(['/assistant'], { queryParams: { connectionId: entry.connectionId } });
    sessionStorage.setItem('sqlpilot.pendingSql', entry.sql);
  }

  badge(status: string): string {
    switch (status) {
      case 'SUCCESS':
        return 'bg-emerald-500/10 text-emerald-500';
      case 'ERROR':
      case 'TIMEOUT':
        return 'bg-red-500/10 text-red-500';
      case 'BLOCKED':
        return 'bg-amber-500/10 text-amber-500';
      default:
        return 'bg-surface-2 text-content-muted';
    }
  }
}
