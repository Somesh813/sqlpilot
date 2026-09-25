import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  GeneratedSql,
  QueryResult,
  SqlExplanation,
  SqlOptimization,
  SqlValidationResult,
} from '@sqlpilot/shared';
import { VisualizationType } from '@sqlpilot/shared';
import { AssistantService } from '../assistant/assistant.service';
import { ConnectionsService } from '../database/connections.service';
import { SchemaExplorerComponent } from '../database/schema-explorer.component';
import { SchemaService } from '../database/schema.service';
import { ToastService } from '../core/services/toast.service';
import { ChartComponent } from '../analytics/chart.component';
import { formatSql } from '../query-editor/format-sql';
import { QueryService } from '../query-editor/query.service';
import { ResultsGridComponent } from '../query-editor/results-grid.component';
import { SqlEditorComponent } from '../query-editor/sql-editor.component';

interface ChatEntry {
  role: 'user' | 'assistant';
  text: string;
  generated?: GeneratedSql;
}

@Component({
  selector: 'sp-workspace',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    SchemaExplorerComponent,
    SqlEditorComponent,
    ResultsGridComponent,
    ChartComponent,
  ],
  templateUrl: './workspace.component.html',
})
export class WorkspaceComponent implements OnInit {
  readonly connections = inject(ConnectionsService);
  readonly schema = inject(SchemaService);
  private readonly assistant = inject(AssistantService);
  private readonly queries = inject(QueryService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly connectionId = signal<string>('');
  readonly sql = signal('');
  readonly question = signal('');
  readonly chat = signal<ChatEntry[]>([]);
  readonly conversationId = signal<string | null>(null);

  readonly thinking = signal(false);
  readonly running = signal(false);
  readonly validation = signal<SqlValidationResult | null>(null);
  readonly result = signal<QueryResult | null>(null);
  readonly execError = signal<{ message: string; databaseError: string | null; suggestion: string | null } | null>(null);

  readonly explanation = signal<SqlExplanation | null>(null);
  readonly optimization = signal<SqlOptimization | null>(null);
  readonly panel = signal<'none' | 'explain' | 'optimize'>('none');
  readonly resultTab = signal<'table' | 'chart'>('table');
  readonly vizType = signal<VisualizationType>(VisualizationType.BAR);

  readonly sidebarOpen = signal(true);
  readonly hasConnection = computed(() => this.connectionId() !== '');

  ngOnInit(): void {
    this.connections.load().subscribe((list) => {
      const preset = this.route.snapshot.queryParamMap.get('connectionId');
      const chosen = preset && list.some((c) => c.id === preset) ? preset : list[0]?.id;
      if (chosen) this.selectConnection(chosen);
    });
    const q = this.route.snapshot.queryParamMap.get('q');
    if (q) {
      this.question.set(q);
      setTimeout(() => this.ask(), 400);
    }

    const pending = sessionStorage.getItem('sqlpilot.pendingSql');
    if (pending) {
      this.sql.set(pending);
      sessionStorage.removeItem('sqlpilot.pendingSql');
    }
  }

  selectConnection(id: string): void {
    this.connectionId.set(id);
    this.result.set(null);
    this.execError.set(null);
    this.validation.set(null);
    this.schema.load(id).subscribe({ error: (e: HttpErrorResponse) => this.toast.error(errText(e)) });
  }

  refreshSchema(): void {
    if (!this.connectionId()) return;
    this.schema.load(this.connectionId(), true).subscribe({
      next: () => this.toast.success('Schema refreshed'),
      error: (e: HttpErrorResponse) => this.toast.error(errText(e)),
    });
  }

  useTable(name: string): void {
    this.sql.set(`SELECT *\nFROM ${name}\nLIMIT 100`);
  }

  readonly examples = [
    'Show the top 10 customers by total spending',
    'How many records are in each table?',
    'Show monthly totals over time',
    'Which items are most popular?',
  ];

  askExample(text: string): void {
    this.question.set(text);
    this.ask();
  }

  askAboutTable(name: string): void {
    this.question.set(`Describe the ${name} table and show a sample of its rows`);
    this.ask();
  }

  ask(): void {
    const q = this.question().trim();
    if (!q || !this.connectionId() || this.thinking()) return;

    this.chat.update((c) => [...c, { role: 'user', text: q }]);
    this.question.set('');
    this.thinking.set(true);

    const send = (conversationId: string | null) =>
      this.assistant.generateSql(this.connectionId(), q, conversationId ?? undefined).subscribe({
        next: (g) => {
          this.thinking.set(false);
          this.chat.update((c) => [
            ...c,
            { role: 'assistant', text: g.unanswerable ? g.unanswerableReason ?? g.explanation : g.explanation, generated: g },
          ]);
          if (g.sql) {
            this.sql.set(g.sql);
            this.validation.set(null);
            if (g.visualization.recommended) this.vizType.set(g.visualization.type);
          }
        },
        error: (e: HttpErrorResponse) => {
          this.thinking.set(false);
          this.chat.update((c) => [...c, { role: 'assistant', text: errText(e) }]);
        },
      });

    if (this.conversationId()) {
      send(this.conversationId());
    } else {
      this.assistant.createConversation(this.connectionId()).subscribe({
        next: (conv) => {
          this.conversationId.set(conv.id);
          send(conv.id);
        },
        error: () => send(null),
      });
    }
  }

  format(): void {
    this.sql.set(formatSql(this.sql()));
  }

  validate(): void {
    if (!this.canRun()) return;
    this.queries.validate(this.connectionId(), this.sql()).subscribe({
      next: (v) => {
        this.validation.set(v);
        this.toast[v.valid ? 'success' : 'error'](
          v.valid ? `Looks safe (${v.risk.toLowerCase()})` : v.violations.map((x) => x.message).join(' '),
        );
      },
      error: (e: HttpErrorResponse) => this.toast.error(errText(e)),
    });
  }

  run(page = 1): void {
    if (!this.canRun() || this.running()) return;
    this.running.set(true);
    this.execError.set(null);
    this.queries
      .execute({
        connectionId: this.connectionId(),
        sql: this.sql(),
        confirmed: true,
        page,
        conversationId: this.conversationId() ?? undefined,
        aiGenerated: this.chat().some((c) => c.generated?.sql === this.sql()),
      })
      .subscribe({
        next: (r) => {
          this.running.set(false);
          this.result.set(r);
          this.resultTab.set('table');
        },
        error: (e: HttpErrorResponse) => {
          this.running.set(false);
          this.result.set(null);
          const body = e.error as { message?: string; databaseError?: string; validation?: SqlValidationResult } | null;
          if (body?.validation) this.validation.set(body.validation);
          this.execError.set({
            message: Array.isArray(body?.message) ? body!.message.join(' ') : body?.message ?? 'Query failed',
            databaseError: body?.databaseError ?? null,
            suggestion: null,
          });
        },
      });
  }

  explain(mode: 'simple' | 'technical'): void {
    if (!this.canRun()) return;
    this.panel.set('explain');
    this.explanation.set(null);
    this.assistant.explainSql(this.connectionId(), this.sql(), mode).subscribe({
      next: (x) => this.explanation.set(x),
      error: (e: HttpErrorResponse) => {
        this.panel.set('none');
        this.toast.error(errText(e));
      },
    });
  }

  optimize(): void {
    if (!this.canRun()) return;
    this.panel.set('optimize');
    this.optimization.set(null);
    this.assistant.optimizeSql(this.connectionId(), this.sql()).subscribe({
      next: (x) => this.optimization.set(x),
      error: (e: HttpErrorResponse) => {
        this.panel.set('none');
        this.toast.error(errText(e));
      },
    });
  }

  fixWithAi(): void {
    const err = this.execError();
    if (!err?.databaseError) return;
    this.thinking.set(true);
    this.assistant.fixSql(this.connectionId(), this.sql(), err.databaseError).subscribe({
      next: (fix) => {
        this.thinking.set(false);
        this.sql.set(fix.fixedSql);
        this.execError.set(null);
        this.toast.success(`AI suggested a fix (${Math.round(fix.confidence * 100)}% confident): ${fix.diagnosis}`);
      },
      error: (e: HttpErrorResponse) => {
        this.thinking.set(false);
        this.toast.error(errText(e));
      },
    });
  }

  applyOptimized(): void {
    const opt = this.optimization();
    if (opt) {
      this.sql.set(opt.optimizedSql);
      this.panel.set('none');
      this.toast.info('Optimized SQL applied to the editor');
    }
  }

  saveQuery(): void {
    const name = prompt('Name this query:');
    if (!name) return;
    this.queries
      .save({ name, sql: this.sql(), connectionId: this.connectionId() })
      .subscribe({ next: () => this.toast.success('Query saved') });
  }

  canRun(): boolean {
    return this.hasConnection() && this.sql().trim().length > 0;
  }

  readonly vizOptions: VisualizationType[] = [
    VisualizationType.BAR,
    VisualizationType.LINE,
    VisualizationType.AREA,
    VisualizationType.PIE,
    VisualizationType.SCATTER,
  ];
}

function errText(e: HttpErrorResponse): string {
  if (e.status === 0) return 'Could not reach the API.';
  const body = e.error as { message?: string | string[] } | null;
  if (Array.isArray(body?.message)) return body.message.join(' ');
  return body?.message ?? e.message ?? 'Request failed';
}
