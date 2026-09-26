import { Component, computed, inject, input } from '@angular/core';
import { summarizeRows, toCsv } from '@sqlpilot/shared';
import { ToastService } from '../../core/services/toast.service';
import { formatCell, humanizeHeader } from '../format-value';

/**
 * Renders any result set: columns and rows come entirely from the data, nothing is
 * hardcoded. Scrolls inside its own box (both axes) so a wide or long result can
 * never stretch the page.
 */
@Component({
  selector: 'sp-data-table',
  standalone: true,
  template: `
    <div class="min-w-0 max-w-full overflow-hidden rounded-xl border border-surface-border bg-surface-0">
      <div class="sp-scroll max-h-80 overflow-auto">
        <table class="min-w-full border-collapse text-left text-sm">
          <thead class="sticky top-0 z-10 bg-surface-2">
            <tr>
              @for (col of columns(); track col) {
                <th
                  class="whitespace-nowrap border-b border-surface-border px-3 py-2 text-xs font-semibold text-content-strong"
                  [class.text-right]="isNumeric(col)"
                  [title]="col"
                >
                  {{ header(col) }}
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of cells(); track $index) {
              <tr class="odd:bg-surface-0 even:bg-surface-1/60 hover:bg-surface-2">
                @for (cell of row; track $index) {
                  <td
                    class="max-w-[22rem] truncate border-b border-surface-border/60 px-3 py-1.5"
                    [class.text-right]="cell.kind === 'number'"
                    [class.tabular-nums]="cell.kind === 'number'"
                    [class.italic]="cell.kind === 'null'"
                    [class.text-content-muted]="cell.kind === 'null'"
                    [class.text-content-strong]="cell.kind !== 'null'"
                    [title]="cell.text"
                  >
                    {{ cell.text }}
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between border-t border-surface-border bg-surface-1 px-3 py-1.5 text-xs text-content-muted">
        <span data-testid="row-summary">
          @if (summary().incomplete) {
            <span class="text-amber-500">{{ summary().text }}</span>
          } @else {
            {{ summary().text }}
          }
          @if (rows().length > maxRows()) {
            <span data-testid="display-cap"> · Displaying the first {{ maxRows().toLocaleString() }} rows here; download the CSV for all {{ rows().length.toLocaleString() }}.</span>
          }
        </span>
        <button class="rounded-md px-2 py-0.5 hover:bg-surface-2 hover:text-content-strong" (click)="download()">
          Download CSV
        </button>
      </div>
    </div>
  `,
})
export class DataTableComponent {
  readonly columns = input.required<string[]>();
  readonly rows = input.required<Array<Record<string, unknown>>>();
  readonly numericColumns = input<string[]>([]);
  readonly totalRows = input<number | null>(null);
  readonly truncated = input(false);
  readonly maxRows = input(200);

  private readonly toast = inject(ToastService);
  private readonly numeric = computed(() => new Set(this.numericColumns()));

  readonly visibleRows = computed(() => this.rows().slice(0, this.maxRows()));

  /** Every visible cell formatted once per data change, not once per change-detection pass. */
  readonly cells = computed(() =>
    this.visibleRows().map((row) => this.columns().map((col) => formatCell(row[col], col, this.numeric()))),
  );
  readonly summary = computed(() => summarizeRows(this.rows().length, this.totalRows(), this.truncated()));

  isNumeric(col: string): boolean {
    return this.numeric().has(col);
  }
  header(col: string): string {
    return humanizeHeader(col);
  }

  download(): void {
    const blob = new Blob([toCsv(this.columns(), this.rows())], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sqlpilot-results.csv';
    a.click();
    URL.revokeObjectURL(url);
    this.toast.info('CSV downloaded');
  }
}
