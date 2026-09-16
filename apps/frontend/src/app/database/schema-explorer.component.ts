import { Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { TableSchema } from '@sqlpilot/shared';
import { SchemaService } from './schema.service';

@Component({
  selector: 'sp-schema-explorer',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-2 border-b border-surface-border p-2">
        <input
          class="sp-input py-1.5 text-xs"
          placeholder="Filter tables…"
          [ngModel]="filter()"
          (ngModelChange)="filter.set($event)"
        />
        <button
          class="shrink-0 rounded-lg border border-surface-border px-2 py-1.5 text-xs text-content hover:bg-surface-2"
          title="Refresh schema"
          [disabled]="schema.loading()"
          (click)="refresh.emit()"
        >
          ↻
        </button>
      </div>

      <div class="sp-scroll min-h-0 flex-1 overflow-y-auto p-1 text-sm">
        @if (schema.loading() && !schema.current()) {
          <p class="p-3 text-xs text-content-muted">Reading schema…</p>
        } @else if (!schema.current()) {
          <p class="p-3 text-xs text-content-muted">Select a connection to browse its schema.</p>
        } @else if (tables().length === 0) {
          <p class="p-3 text-xs text-content-muted">No tables match.</p>
        } @else {
          @for (table of tables(); track table.name) {
            <div class="mb-0.5">
              <button
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
                (click)="toggle(table.name)"
              >
                <span class="text-content-muted">{{ expanded().has(table.name) ? '▾' : '▸' }}</span>
                <span class="truncate font-medium text-content-strong">{{ table.name }}</span>
                @if (table.kind === 'view') {
                  <span class="ml-auto text-[10px] uppercase text-content-muted">view</span>
                }
              </button>
              @if (expanded().has(table.name)) {
                <div class="ml-6 border-l border-surface-border pl-2">
                  @for (col of table.columns; track col.name) {
                    <div class="flex items-center gap-2 py-1 text-xs">
                      <span class="text-content-strong">{{ col.name }}</span>
                      <span class="text-content-muted">{{ col.dataType }}</span>
                      @if (col.isPrimaryKey) { <span class="text-amber-500" title="Primary key">PK</span> }
                      @if (col.isForeignKey) { <span class="text-brand-400" title="Foreign key">FK</span> }
                      @if (!col.nullable) { <span class="text-content-muted">·</span> }
                    </div>
                  }
                  <div class="flex gap-2 py-1.5">
                    <button class="text-xs text-brand-500 hover:text-brand-400" (click)="selectTable.emit(table.name)">
                      Query
                    </button>
                    <button class="text-xs text-brand-500 hover:text-brand-400" (click)="askAbout.emit(table.name)">
                      Ask AI
                    </button>
                  </div>
                </div>
              }
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class SchemaExplorerComponent {
  @Output() refresh = new EventEmitter<void>();
  @Output() selectTable = new EventEmitter<string>();
  @Output() askAbout = new EventEmitter<string>();

  readonly schema = inject(SchemaService);
  readonly filter = signal('');
  readonly expanded = signal(new Set<string>());

  readonly tables = computed<TableSchema[]>(() => {
    const all = this.schema.current()?.tables ?? [];
    const f = this.filter().trim().toLowerCase();
    return f ? all.filter((t) => t.name.toLowerCase().includes(f)) : all;
  });

  toggle(name: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }
}
