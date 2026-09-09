import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { DashboardStats } from '@sqlpilot/shared';
import { AuthService } from '../core/services/auth.service';
import { EmptyStateComponent } from '../shared/ui/empty-state.component';
import { PageComponent } from '../shared/ui/page.component';
import { DashboardService } from './dashboard.service';

interface StatCard {
  label: string;
  value: string;
  hint: string;
}

@Component({
  selector: 'sp-dashboard',
  standalone: true,
  imports: [PageComponent, EmptyStateComponent, FormsModule],
  template: `
    <sp-page title="Dashboard" [subtitle]="greeting()">
      <section class="sp-card mb-6 p-5 lg:p-6">
        <label class="sp-label" for="ask">Ask SQLPilot</label>
        <div class="flex flex-col gap-3 sm:flex-row">
          <input
            id="ask"
            class="sp-input"
            placeholder="Ask anything about your data…"
            [ngModel]="question()"
            (ngModelChange)="question.set($event)"
            (keyup.enter)="ask()"
          />
          <button class="sp-btn-primary shrink-0 sm:w-32" (click)="ask()">Ask</button>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          @for (example of examples; track example) {
            <button
              class="rounded-lg border border-surface-border bg-surface-0 px-2.5 py-1 text-xs text-content-muted hover:text-content-strong"
              (click)="question.set(example); ask()"
            >
              {{ example }}
            </button>
          }
        </div>
      </section>

      <section class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        @for (card of cards(); track card.label) {
          <div class="sp-card p-4">
            <p class="text-xs uppercase tracking-wide text-content-muted">{{ card.label }}</p>
            <p class="mt-2 text-2xl font-semibold text-content-strong">{{ card.value }}</p>
            <p class="mt-1 text-xs text-content-muted">{{ card.hint }}</p>
          </div>
        }
      </section>

      <h2 class="mb-3 text-sm font-semibold text-content-strong">Recent queries</h2>
      @if ((stats()?.recentQueries?.length ?? 0) === 0) {
        <sp-empty-state
          icon="↺"
          title="Your query history will appear here"
          description="Connect a database and run your first query to see it here."
        >
          <button class="sp-btn-primary mt-2" (click)="goToConnections()">Connect Database</button>
        </sp-empty-state>
      } @else {
        <div class="sp-card divide-y divide-surface-border">
          @for (q of stats()!.recentQueries; track q.id) {
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <p class="truncate text-sm text-content-strong">{{ q.prompt || q.sql }}</p>
                <p class="truncate font-mono text-xs text-content-muted">{{ q.sql }}</p>
              </div>
              <span class="shrink-0 text-xs text-content-muted">{{ q.connectionName }}</span>
            </div>
          }
        </div>
      }
    </sp-page>
  `,
})
export class DashboardComponent implements OnInit {
  private readonly dashboard = inject(DashboardService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly question = signal('');
  readonly stats = signal<DashboardStats | null>(null);

  readonly examples = [
    'Show monthly revenue',
    'Find my top customers',
    'Which products are declining?',
    'Show failed transactions',
    'Compare sales this year vs last year',
  ];

  greeting(): string {
    const name = this.auth.user()?.name?.split(' ')[0];
    return name ? `Welcome back, ${name}.` : 'Welcome to SQLPilot.';
  }

  cards(): StatCard[] {
    const s = this.stats();
    return [
      { label: 'Databases', value: String(s?.connectedDatabases ?? 0), hint: `${s?.totalConnections ?? 0} configured` },
      { label: 'Total queries', value: String(s?.totalQueries ?? 0), hint: `${s?.queriesToday ?? 0} today` },
      { label: 'AI generated', value: String(s?.aiGeneratedQueries ?? 0), hint: 'via the assistant' },
      {
        label: 'Success rate',
        value: s ? `${Math.round(s.successRate * 100)}%` : '—',
        hint: s ? `${s.avgExecutionTimeMs} ms avg` : 'no data yet',
      },
    ];
  }

  ngOnInit(): void {
    this.dashboard.getStats().subscribe((stats) => this.stats.set(stats));
  }

  ask(): void {
    const q = this.question().trim();
    if (!q) return;
    this.router.navigate(['/assistant'], { queryParams: { q } });
  }

  goToConnections(): void {
    this.router.navigate(['/connections']);
  }
}
