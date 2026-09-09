import { Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  CreateConnectionRequest,
  DEFAULT_PORTS,
  DatabaseType,
  SafeDatabaseConnection,
  TestConnectionResult,
} from '@sqlpilot/shared';
import { ToastService } from '../core/services/toast.service';
import { ConnectionsService } from './connections.service';

@Component({
  selector: 'sp-connection-form',
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    <div class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
      <div class="sp-card w-full max-w-lg p-6">
        <div class="mb-5 flex items-center justify-between">
          <h2 class="text-base font-semibold text-content-strong">
            {{ editing ? 'Edit connection' : 'New database connection' }}
          </h2>
          <button class="text-content-muted hover:text-content-strong" (click)="close.emit()">✕</button>
        </div>

        <form class="space-y-4" [formGroup]="form" (ngSubmit)="save()">
          <div class="grid grid-cols-2 gap-3">
            <div class="col-span-2">
              <label class="sp-label" for="cname">Connection name</label>
              <input id="cname" class="sp-input" formControlName="name" placeholder="Production DB" />
            </div>

            <div class="col-span-2">
              <label class="sp-label" for="ctype">Engine</label>
              <select id="ctype" class="sp-input" formControlName="type" (change)="onTypeChange()">
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="sqlite">SQLite</option>
              </select>
            </div>

            @if (form.value.type !== 'sqlite') {
              <div>
                <label class="sp-label" for="chost">Host</label>
                <input id="chost" class="sp-input" formControlName="host" placeholder="localhost" />
              </div>
              <div>
                <label class="sp-label" for="cport">Port</label>
                <input id="cport" type="number" class="sp-input" formControlName="port" />
              </div>
              <div class="col-span-2">
                <label class="sp-label" for="cdb">Database</label>
                <input id="cdb" class="sp-input" formControlName="database" placeholder="app" />
              </div>
              <div>
                <label class="sp-label" for="cuser">Username</label>
                <input id="cuser" class="sp-input" formControlName="username" autocomplete="off" />
              </div>
              <div>
                <label class="sp-label" for="cpass">Password</label>
                <input
                  id="cpass"
                  type="password"
                  class="sp-input"
                  formControlName="password"
                  autocomplete="new-password"
                  [placeholder]="editing ? 'unchanged' : ''"
                />
              </div>
              <label class="col-span-2 flex items-center gap-2 text-sm text-content">
                <input type="checkbox" formControlName="ssl" class="rounded border-surface-border" />
                Use SSL
              </label>
            } @else {
              <div class="col-span-2">
                <label class="sp-label" for="cpath">Database file path</label>
                <input
                  id="cpath"
                  class="sp-input"
                  formControlName="filePath"
                  placeholder="D:\\data\\app.sqlite"
                />
                <p class="mt-1 text-xs text-content-muted">
                  Absolute path on the machine running the API.
                </p>
              </div>
              <div class="col-span-2">
                <label class="sp-label" for="cdb2">Display name</label>
                <input id="cdb2" class="sp-input" formControlName="database" placeholder="app" />
              </div>
            }
          </div>

          @if (testResult(); as r) {
            <p
              class="rounded-lg border px-3 py-2 text-xs"
              [class]="r.ok ? 'border-emerald-500/40 text-emerald-500' : 'border-red-500/40 text-red-500'"
            >
              @if (r.ok) {
                Connected in {{ r.latencyMs }} ms{{ r.serverVersion ? ' · ' + r.serverVersion : '' }}
              } @else {
                {{ r.error }}
              }
            </p>
          }

          <div class="flex items-center justify-between pt-2">
            <button
              type="button"
              class="sp-btn-ghost"
              [disabled]="testing() || form.invalid"
              (click)="test()"
            >
              {{ testing() ? 'Testing…' : 'Test connection' }}
            </button>
            <div class="flex gap-2">
              <button type="button" class="sp-btn-ghost" (click)="close.emit()">Cancel</button>
              <button type="submit" class="sp-btn-primary" [disabled]="saving() || form.invalid">
                {{ saving() ? 'Saving…' : editing ? 'Save' : 'Create' }}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `,
})
export class ConnectionFormComponent implements OnInit {
  @Input() connection: SafeDatabaseConnection | null = null;
  @Output() close = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  private readonly fb = inject(FormBuilder);
  private readonly connections = inject(ConnectionsService);
  private readonly toast = inject(ToastService);

  readonly testing = signal(false);
  readonly saving = signal(false);
  readonly testResult = signal<TestConnectionResult | null>(null);

  get editing(): boolean {
    return this.connection !== null;
  }

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    type: ['postgres' as DatabaseType, [Validators.required]],
    host: ['localhost'],
    port: [DEFAULT_PORTS['postgres'] as number],
    database: ['', [Validators.required]],
    filePath: [''],
    username: [''],
    password: [''],
    ssl: [false],
  });

  ngOnInit(): void {
    if (this.connection) {
      this.form.patchValue({
        name: this.connection.name,
        type: this.connection.type,
        host: this.connection.host ?? '',
        port: this.connection.port ?? 0,
        database: this.connection.database,
        filePath: this.connection.filePath ?? '',
        ssl: this.connection.ssl,
      });
    }
    this.applyConditionalValidators();
  }

  onTypeChange(): void {
    const type = this.form.controls.type.value;
    const port = DEFAULT_PORTS[type];
    if (type !== 'sqlite' && port) this.form.controls.port.setValue(port);
    this.testResult.set(null);
    this.applyConditionalValidators();
  }

  private applyConditionalValidators(): void {
    const isSqlite = this.form.controls.type.value === 'sqlite';
    const set = (name: 'host' | 'username' | 'filePath', on: boolean) => {
      const c = this.form.controls[name];
      c.setValidators(on ? [Validators.required] : []);
      c.updateValueAndValidity({ emitEvent: false });
    };
    set('host', !isSqlite);
    set('username', !isSqlite);
    set('filePath', isSqlite);
  }

  private payload(): CreateConnectionRequest {
    const v = this.form.getRawValue();
    if (v.type === 'sqlite') {
      return { name: v.name, type: v.type, database: v.database, filePath: v.filePath };
    }
    const base: CreateConnectionRequest = {
      name: v.name,
      type: v.type,
      host: v.host,
      port: Number(v.port),
      database: v.database,
      username: v.username,
      ssl: v.ssl,
    };
    // Only send a password when the user typed one (blank = unchanged on edit).
    return v.password ? { ...base, password: v.password } : base;
  }

  test(): void {
    this.testing.set(true);
    this.testResult.set(null);
    this.connections.testNew(this.payload()).subscribe({
      next: (r) => {
        this.testResult.set(r);
        this.testing.set(false);
      },
      error: (e: HttpErrorResponse) => {
        this.testing.set(false);
        this.testResult.set({ ok: false, latencyMs: null, serverVersion: null, error: errText(e) });
      },
    });
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    const request = this.connection
      ? this.connections.update(this.connection.id, this.payload())
      : this.connections.create(this.payload());
    request.subscribe({
      next: () => {
        this.toast.success(this.editing ? 'Connection updated.' : 'Connection added.');
        this.saving.set(false);
        this.saved.emit();
      },
      error: () => this.saving.set(false),
    });
  }
}

function errText(e: HttpErrorResponse): string {
  const body = e.error as { message?: string | string[] } | null;
  if (Array.isArray(body?.message)) return body.message.join(' ');
  return body?.message ?? e.message ?? 'Connection test failed.';
}
