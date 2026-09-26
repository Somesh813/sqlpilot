import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { VisualizationType, type AskResponse, type QueryResult } from '@sqlpilot/shared';
import { ChartComponent } from '../analytics/chart.component';
import { ToastService } from '../core/services/toast.service';
import { formatCell, humanizeHeader } from '../shared/format-value';
import { DataTableComponent } from '../shared/ui/data-table.component';

/**
 * One assistant reply. Hierarchy is deliberate: the ANSWER first, then the DATA,
 * then a chart when the data warrants one, and the SQL last, behind a toggle — the
 * user should never need to read SQL to understand the reply.
 */
@Component({
  selector: 'sp-answer-card',
  standalone: true,
  imports: [DataTableComponent, ChartComponent],
  template: `
    <div class="min-w-0 space-y-3">
      <p class="text-[15px] leading-relaxed text-content-strong">{{ response().explanation }}</p>

      @if (response().success) {
        @switch (response().resultType) {
          @case ('empty') {
            <div class="rounded-xl border border-dashed border-surface-border px-4 py-6 text-center text-sm text-content-muted">
              No results found for this query.
            </div>
          }
          @case ('single_value') {
            <div class="flex flex-wrap gap-3">
              @for (col of response().columns; track col) {
                <div class="min-w-[10rem] rounded-xl border border-surface-border bg-surface-0 px-5 py-4">
                  <p class="text-xs text-content-muted">{{ header(col) }}</p>
                  <p class="mt-1 text-3xl font-semibold tabular-nums text-content-strong">{{ kpi(col) }}</p>
                </div>
              }
            </div>
          }
          @default {
            @if (chartViews().length) {
              <div class="flex flex-wrap items-center gap-1.5 text-xs">
                <span class="mr-1 text-content-muted">View</span>
                <button [class]="pill(view() === 'table')" (click)="view.set(tableView)">Table</button>
                @for (v of chartViews(); track v) {
                  <button [class]="pill(view() === v)" (click)="view.set(v)">{{ label(v) }}</button>
                }
              </div>
            }
            @if (isChart()) {
              <div class="h-72 min-w-0 rounded-xl border border-surface-border bg-surface-0 p-3">
                <sp-chart
                  [result]="asQueryResult()"
                  [type]="view()"
                  [xField]="response().visualization.xColumn"
                  [yFields]="response().visualization.yColumns"
                />
              </div>
            }
            <sp-data-table
              [columns]="response().columns"
              [rows]="response().rows"
              [numericColumns]="response().numericColumns"
              [totalRows]="response().totalRows"
              [truncated]="response().truncated"
            />
          }
        }

        <p class="text-xs text-content-muted">
          {{ response().executionTimeMs }} ms
          @if (response().autoFixed) {
            · <span class="text-amber-500" title="The first query failed, so SQLPilot corrected it and ran it again">auto-corrected</span>
          }
        </p>

        @for (w of response().warnings; track w) {
          <p class="text-xs text-amber-500">⚠ {{ w }}</p>
        }
      } @else if (response().error?.technical) {
        <details class="rounded-xl border border-surface-border bg-surface-0 text-xs">
          <summary class="cursor-pointer px-3 py-2 text-content-muted hover:text-content-strong">Technical details</summary>
          <pre class="sp-scroll max-h-40 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-content-muted">{{ response().error?.technical }}</pre>
        </details>
      }

      @if (response().sql) {
        <details class="rounded-xl border border-surface-border bg-surface-0 text-xs">
          <summary class="cursor-pointer px-3 py-2 text-content-muted hover:text-content-strong">View SQL</summary>
          <div class="space-y-2 px-3 pb-3">
            <pre class="sp-scroll max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-1 p-2 font-mono text-[12px] text-content-strong">{{ response().sql }}</pre>
            @if (response().queryExplanation) {
              <p class="text-content-muted">{{ response().queryExplanation }}</p>
            }
            @if (response().assumptions.length) {
              <p class="text-content-muted">Assumptions: {{ response().assumptions.join('; ') }}</p>
            }
            <div class="flex gap-2">
              <button class="sp-btn-ghost px-2.5 py-1 text-xs" (click)="copySql()">Copy</button>
              <button class="sp-btn-ghost px-2.5 py-1 text-xs" (click)="openInEditor.emit(response().sql)">
                Open in SQL editor
              </button>
            </div>
          </div>
        </details>
      }
    </div>
  `,
})
export class AnswerCardComponent implements OnInit {
  readonly response = input.required<AskResponse>();
  readonly openInEditor = output<string>();

  readonly tableView = VisualizationType.TABLE;
  readonly view = signal<VisualizationType>(VisualizationType.TABLE);
  private readonly toast = inject(ToastService);

  readonly chartViews = computed<VisualizationType[]>(() =>
    this.response().availableViews.filter((v) => v !== VisualizationType.TABLE && v !== VisualizationType.KPI),
  );
  readonly isChart = computed(() => this.view() !== VisualizationType.TABLE);

  /** Adapter so the shared chart component can draw an AskResponse. */
  readonly asQueryResult = computed<QueryResult>(() => {
    const r = this.response();
    return {
      columns: r.columns.map((name) => ({ name, type: r.columnTypes[name] ?? null })),
      rows: r.rows,
      returnedRows: r.returnedRows,
      totalRows: r.totalRows,
      executionTimeMs: r.executionTimeMs,
      truncated: r.truncated,
      status: 'SUCCESS' as never,
      historyId: r.historyId,
    };
  });

  ngOnInit(): void {
    const v = this.response().visualization;
    // open on the recommended chart when there is one; otherwise just the table
    if (v.recommended && v.type && this.chartViews().includes(v.type)) this.view.set(v.type);
  }

  header(col: string): string {
    return humanizeHeader(col);
  }

  kpi(col: string): string {
    return formatCell(this.response().rows[0]?.[col], col, new Set(this.response().numericColumns)).text;
  }

  label(v: VisualizationType): string {
    return `${v.charAt(0).toUpperCase()}${v.slice(1)}`;
  }

  pill(active: boolean): string {
    return `rounded-lg border px-2.5 py-1 ${
      active
        ? 'border-brand-500 bg-brand-500/10 text-content-strong'
        : 'border-surface-border text-content-muted hover:text-content-strong'
    }`;
  }

  copySql(): void {
    void navigator.clipboard?.writeText(this.response().sql).then(() => this.toast.info('SQL copied'));
  }
}
