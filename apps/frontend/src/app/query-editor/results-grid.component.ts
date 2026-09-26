import { Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { summarizeRows, toCsv, type QueryResult } from '@sqlpilot/shared';
import { ToastService } from '../core/services/toast.service';
import { inject } from '@angular/core';

type SortDir = 'asc' | 'desc' | null;

@Component({
  selector: 'sp-results-grid',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (result(); as r) {
      <div class="flex h-full flex-col">
        <div class="flex flex-wrap items-center gap-3 border-b border-surface-border p-2 text-xs">
          <span class="text-content-muted" data-testid="row-summary">
            @if (summary().incomplete) {
              <span class="text-amber-500">{{ summary().text }}</span>
            } @else {
              {{ summary().text }}
            }
            · {{ r.executionTimeMs }} ms
          </span>
          <input
            class="sp-input ml-auto w-48 py-1 text-xs"
            placeholder="Search results…"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <button class="rounded-lg border border-surface-border px-2 py-1 hover:bg-surface-2" (click)="exportCsv()">
            CSV
          </button>
          <button class="rounded-lg border border-surface-border px-2 py-1 hover:bg-surface-2" (click)="exportJson()">
            JSON
          </button>
        </div>

        <div class="sp-scroll min-h-0 flex-1 overflow-auto">
          <table class="w-full border-collapse text-left text-xs">
            <thead class="sticky top-0 bg-surface-1">
              <tr>
                @for (col of r.columns; track col.name) {
                  <th
                    class="cursor-pointer whitespace-nowrap border-b border-surface-border px-3 py-2 font-medium text-content-strong hover:bg-surface-2"
                    (click)="sortBy(col.name)"
                  >
                    {{ col.name }}
                    @if (sortKey() === col.name) { {{ sortDir() === 'asc' ? '▲' : '▼' }} }
                    <span class="ml-1 font-normal text-content-muted">{{ col.type }}</span>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of viewRows(); track $index) {
                <tr class="hover:bg-surface-1">
                  @for (col of r.columns; track col.name) {
                    <td
                      class="max-w-[28rem] truncate border-b border-surface-border px-3 py-1.5 text-content"
                      [title]="display(row[col.name])"
                      (click)="copyCell(row[col.name])"
                    >
                      {{ display(row[col.name]) }}
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
          @if (viewRows().length === 0) {
            <p class="p-4 text-xs text-content-muted">No rows.</p>
          }
        </div>

      </div>
    }
  `,
})
export class ResultsGridComponent {
  readonly result = input.required<QueryResult>();

  private readonly toast = inject(ToastService);
  readonly search = signal('');
  readonly sortKey = signal<string | null>(null);
  readonly sortDir = signal<SortDir>(null);

  readonly summary = computed(() => {
    const r = this.result();
    return summarizeRows(r.returnedRows, r.totalRows, r.truncated);
  });

  readonly viewRows = computed(() => {
    const r = this.result();
    let rows = [...r.rows];
    const q = this.search().trim().toLowerCase();
    if (q) {
      rows = rows.filter((row) =>
        r.columns.some((c) => this.display(row[c.name]).toLowerCase().includes(q)),
      );
    }
    const key = this.sortKey();
    const dir = this.sortDir();
    if (key && dir) {
      rows.sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : this.display(av).localeCompare(this.display(bv));
        return dir === 'asc' ? cmp : -cmp;
      });
    }
    return rows;
  });

  sortBy(key: string): void {
    if (this.sortKey() !== key) {
      this.sortKey.set(key);
      this.sortDir.set('asc');
    } else {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : this.sortDir() === 'desc' ? null : 'asc');
      if (this.sortDir() === null) this.sortKey.set(null);
    }
  }

  display(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  copyCell(value: unknown): void {
    void navigator.clipboard?.writeText(this.display(value)).then(() => this.toast.info('Cell copied'));
  }

  exportCsv(): void {
    const r = this.result();
    this.download(
      toCsv(
        r.columns.map((c) => c.name),
        this.viewRows(),
      ),
      'text/csv',
      'sqlpilot-results.csv',
    );
  }

  exportJson(): void {
    this.download(JSON.stringify(this.viewRows(), null, 2), 'application/json', 'sqlpilot-results.json');
  }

  private download(content: string, mime: string, filename: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}
