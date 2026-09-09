import { Component, OnInit, inject, signal } from '@angular/core';
import type { SafeDatabaseConnection } from '@sqlpilot/shared';
import { ToastService } from '../core/services/toast.service';
import { EmptyStateComponent } from '../shared/ui/empty-state.component';
import { PageComponent } from '../shared/ui/page.component';
import { ConnectionFormComponent } from './connection-form.component';
import { ConnectionsService } from './connections.service';

@Component({
  selector: 'sp-connections',
  standalone: true,
  imports: [PageComponent, EmptyStateComponent, ConnectionFormComponent],
  template: `
    <sp-page title="Connections" subtitle="Databases SQLPilot can query.">
      <button actions class="sp-btn-primary" (click)="openCreate()">Add connection</button>

      @if (!connections.loaded()) {
        <div class="sp-card p-8 text-center text-sm text-content-muted">Loading connections…</div>
      } @else if (connections.connections().length === 0) {
        <sp-empty-state
          icon="⛁"
          title="No databases connected"
          description="Connect your first database to start asking questions."
        >
          <button class="sp-btn-primary mt-2" (click)="openCreate()">Connect Database</button>
        </sp-empty-state>
      } @else {
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          @for (c of connections.connections(); track c.id) {
            <div class="sp-card flex flex-col gap-3 p-4">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="truncate font-medium text-content-strong">{{ c.name }}</p>
                  <p class="text-xs uppercase tracking-wide text-content-muted">{{ c.type }}</p>
                </div>
                <span
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
                  [class]="badge(c.status)"
                >
                  {{ c.status }}
                </span>
              </div>

              <p class="truncate font-mono text-xs text-content-muted">
                {{ c.type === 'sqlite' ? c.filePath : c.host + ':' + c.port + '/' + c.database }}
              </p>

              @if (c.lastError && c.status === 'ERROR') {
                <p class="line-clamp-2 text-xs text-red-500">{{ c.lastError }}</p>
              }

              <div class="mt-auto flex flex-wrap gap-2 pt-1">
                <button class="sp-btn-ghost px-2.5 py-1 text-xs" (click)="test(c)" [disabled]="busyId() === c.id">
                  {{ busyId() === c.id ? 'Testing…' : 'Test' }}
                </button>
                <button class="sp-btn-ghost px-2.5 py-1 text-xs" (click)="openEdit(c)">Edit</button>
                <button class="sp-btn-ghost px-2.5 py-1 text-xs text-red-500" (click)="remove(c)">
                  Delete
                </button>
              </div>
            </div>
          }
        </div>
      }
    </sp-page>

    @if (formOpen()) {
      <sp-connection-form
        [connection]="editing()"
        (close)="closeForm()"
        (saved)="closeForm()"
      />
    }
  `,
})
export class ConnectionsComponent implements OnInit {
  readonly connections = inject(ConnectionsService);
  private readonly toast = inject(ToastService);

  readonly formOpen = signal(false);
  readonly editing = signal<SafeDatabaseConnection | null>(null);
  readonly busyId = signal<string | null>(null);

  ngOnInit(): void {
    this.connections.load().subscribe();
  }

  openCreate(): void {
    this.editing.set(null);
    this.formOpen.set(true);
  }

  openEdit(c: SafeDatabaseConnection): void {
    this.editing.set(c);
    this.formOpen.set(true);
  }

  closeForm(): void {
    this.formOpen.set(false);
    this.editing.set(null);
  }

  test(c: SafeDatabaseConnection): void {
    this.busyId.set(c.id);
    this.connections.testExisting(c.id).subscribe({
      next: (r) => {
        this.busyId.set(null);
        r.ok ? this.toast.success(`${c.name}: connected in ${r.latencyMs} ms`) : this.toast.error(`${c.name}: ${r.error}`);
      },
      error: () => this.busyId.set(null),
    });
  }

  remove(c: SafeDatabaseConnection): void {
    if (!confirm(`Delete the connection "${c.name}"? This does not affect the database itself.`)) return;
    this.connections.remove(c.id).subscribe({
      next: () => this.toast.success('Connection deleted.'),
    });
  }

  badge(status: string): string {
    switch (status) {
      case 'CONNECTED':
        return 'bg-emerald-500/10 text-emerald-500';
      case 'ERROR':
        return 'bg-red-500/10 text-red-500';
      default:
        return 'bg-surface-2 text-content-muted';
    }
  }
}
