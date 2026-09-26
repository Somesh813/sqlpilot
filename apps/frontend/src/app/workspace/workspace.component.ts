import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  analyzeResult,
  VisualizationType,
  type AskResponse,
  type QueryResult,
  type ResultAnalysis,
  type SqlExplanation,
  type SqlOptimization,
  type SqlValidationResult,
} from '@sqlpilot/shared';
import { AssistantService } from '../assistant/assistant.service';
import { AnswerCardComponent } from '../assistant/answer-card.component';
import { ConnectionsService } from '../database/connections.service';
import { SchemaExplorerComponent } from '../database/schema-explorer.component';
import { SchemaService } from '../database/schema.service';
import { ToastService } from '../core/services/toast.service';
import { ChartComponent } from '../analytics/chart.component';
import { formatSql } from '../query-editor/format-sql';
import { QueryService } from '../query-editor/query.service';
import { ResultsGridComponent } from '../query-editor/results-grid.component';
import { SqlEditorComponent } from '../query-editor/sql-editor.component';

/** A chat turn: what the user typed, or a full assistant response (or a plain error line). */
interface ChatEntry {
  role: 'user' | 'assistant';
  text?: string;
  response?: AskResponse;
}

const PROGRESS_STEPS = [
  'Understanding your question…',
  'Generating query…',
  'Running database query…',
  'Preparing results…',
];

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
    AnswerCardComponent,
  ],
  templateUrl: './workspace.component.html',
  // The host must be a block with a real height, or every h-full descendant collapses.
  host: { class: 'block h-full min-h-0' },
})
export class WorkspaceComponent implements OnInit, OnDestroy {
  readonly connections = inject(ConnectionsService);
  readonly schema = inject(SchemaService);
  private readonly assistant = inject(AssistantService);
  private readonly queries = inject(QueryService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  @ViewChild('scroller') scroller?: ElementRef<HTMLDivElement>;

  /** 'chat' is the product: ask in plain English. 'editor' is the advanced SQL view. */
  readonly mode = signal<'chat' | 'editor'>('chat');
  readonly connectionId = signal<string>('');
  readonly sidebarOpen = signal(false);
  readonly hasConnection = computed(() => this.connectionId() !== '');

  // ---- chat state ----
  readonly question = signal('');
  readonly chat = signal<ChatEntry[]>([]);
  readonly conversationId = signal<string | null>(null);
  readonly thinking = signal(false);
  readonly progressStep = signal(0);
  readonly progressLabel = computed(() => PROGRESS_STEPS[this.progressStep()]);
  private progressTimer?: ReturnType<typeof setInterval>;

  readonly examples = [
    'How many records are in each table?',
    'Show the top 10 customers by total spending',
    'Show monthly totals over time',
    'Which items are the most popular?',
  ];

  // ---- advanced editor state ----
  readonly sql = signal('');
  readonly running = signal(false);
  readonly validation = signal<SqlValidationResult | null>(null);
  readonly result = signal<QueryResult | null>(null);
  readonly analysis = signal<ResultAnalysis | null>(null);
  readonly execError = signal<{ message: string; databaseError: string | null } | null>(null);
  readonly explanation = signal<SqlExplanation | null>(null);
  readonly optimization = signal<SqlOptimization | null>(null);
  readonly panel = signal<'none' | 'explain' | 'optimize'>('none');
  readonly resultTab = signal<'table' | 'chart'>('table');
  readonly vizType = signal<VisualizationType>(VisualizationType.BAR);
  readonly vizOptions = computed(() =>
    (this.analysis()?.availableViews ?? []).filter((v) => v !== VisualizationType.TABLE && v !== VisualizationType.KPI),
  );

  ngOnInit(): void {
    this.connections.load().subscribe((list) => {
      const preset = this.route.snapshot.queryParamMap.get('connectionId');
      const chosen = preset && list.some((c) => c.id === preset) ? preset : list[0]?.id;
      if (chosen) this.selectConnection(chosen);
    });

    const pending = sessionStorage.getItem('sqlpilot.pendingSql');
    if (pending) {
      this.sql.set(pending);
      this.mode.set('editor');
      sessionStorage.removeItem('sqlpilot.pendingSql');
    }

    const q = this.route.snapshot.queryParamMap.get('q');
    if (q) {
      this.question.set(q);
      setTimeout(() => this.ask(), 400);
    }
  }

  ngOnDestroy(): void {
    this.stopProgress();
  }

  selectConnection(id: string): void {
    if (id !== this.connectionId()) this.newChat(false);
    this.connectionId.set(id);
    this.result.set(null);
    this.analysis.set(null);
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

  newChat(notify = true): void {
    this.chat.set([]);
    this.conversationId.set(null);
    this.stopProgress();
    this.thinking.set(false);
    if (notify) this.toast.info('Started a new conversation');
  }

  // ---------------------------------------------------------------------------
  // Chat: one call returns the answer AND the data
  // ---------------------------------------------------------------------------

  ask(): void {
    const q = this.question().trim();
    if (!q || !this.connectionId() || this.thinking()) return;

    this.chat.update((c) => [...c, { role: 'user', text: q }]);
    this.question.set('');
    this.startProgress();
    this.scrollDown();

    this.assistant.ask(this.connectionId(), q, this.conversationId() ?? undefined).subscribe({
      next: (r) => {
        this.stopProgress();
        if (r.conversationId) this.conversationId.set(r.conversationId);
        this.chat.update((c) => [...c, { role: 'assistant', response: r }]);
        this.scrollDown();
      },
      error: (e: HttpErrorResponse) => {
        this.stopProgress();
        this.chat.update((c) => [...c, { role: 'assistant', text: errText(e) }]);
        this.scrollDown();
      },
    });
  }

  askExample(text: string): void {
    this.question.set(text);
    this.ask();
  }

  askAboutTable(name: string): void {
    this.mode.set('chat');
    this.question.set(`Describe the ${name} table and show a sample of its rows`);
    this.ask();
  }

  openInEditor(sql: string): void {
    this.sql.set(sql);
    this.validation.set(null);
    this.mode.set('editor');
  }

  useTable(name: string): void {
    this.sql.set(`SELECT *\nFROM ${name}\nLIMIT 100`);
    this.mode.set('editor');
  }

  private startProgress(): void {
    this.thinking.set(true);
    this.progressStep.set(0);
    this.progressTimer = setInterval(
      () => this.progressStep.update((s) => Math.min(s + 1, PROGRESS_STEPS.length - 1)),
      1600,
    );
  }

  private stopProgress(): void {
    clearInterval(this.progressTimer);
    this.thinking.set(false);
  }

  private scrollDown(): void {
    setTimeout(() => {
      const el = this.scroller?.nativeElement;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, 30);
  }

  // ---------------------------------------------------------------------------
  // Advanced: hand-written SQL
  // ---------------------------------------------------------------------------

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

  run(): void {
    if (!this.canRun() || this.running()) return;
    this.running.set(true);
    this.execError.set(null);
    this.queries
      .execute({
        connectionId: this.connectionId(),
        sql: this.sql(),
        confirmed: true,
        conversationId: this.conversationId() ?? undefined,
      })
      .subscribe({
        next: (r) => {
          this.running.set(false);
          this.result.set(r);
          const a = analyzeResult(
            r.columns.map((c) => c.name),
            r.rows,
          );
          this.analysis.set(a);
          const chart = a.visualization.type;
          if (chart && chart !== VisualizationType.KPI) this.vizType.set(chart);
          else if (this.vizOptions().length) this.vizType.set(this.vizOptions()[0]);
          this.resultTab.set('table');
        },
        error: (e: HttpErrorResponse) => {
          this.running.set(false);
          this.result.set(null);
          this.analysis.set(null);
          const body = e.error as { message?: string | string[]; databaseError?: string; validation?: SqlValidationResult } | null;
          if (body?.validation) this.validation.set(body.validation);
          this.execError.set({
            message: Array.isArray(body?.message) ? body!.message.join(' ') : (body?.message ?? 'Query failed'),
            databaseError: body?.databaseError ?? null,
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
    this.assistant.fixSql(this.connectionId(), this.sql(), err.databaseError).subscribe({
      next: (fix) => {
        this.sql.set(fix.fixedSql);
        this.execError.set(null);
        this.toast.success(`AI suggested a fix (${Math.round(fix.confidence * 100)}% confident): ${fix.diagnosis}`);
      },
      error: (e: HttpErrorResponse) => this.toast.error(errText(e)),
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
}

function errText(e: HttpErrorResponse): string {
  if (e.status === 0) return 'Could not reach the server. Make sure the API is running.';
  const body = e.error as { message?: string | string[] } | null;
  if (Array.isArray(body?.message)) return body.message.join(' ');
  return body?.message ?? e.message ?? 'Request failed';
}
