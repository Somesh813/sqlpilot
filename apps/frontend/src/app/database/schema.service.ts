import { Injectable, inject, signal } from '@angular/core';
import type { DatabaseSchemaSnapshot } from '@sqlpilot/shared';
import { Observable, tap } from 'rxjs';
import { ApiService } from '../core/services/api.service';

@Injectable({ providedIn: 'root' })
export class SchemaService {
  private readonly api = inject(ApiService);

  private readonly cache = new Map<string, DatabaseSchemaSnapshot>();
  readonly current = signal<DatabaseSchemaSnapshot | null>(null);
  readonly loading = signal(false);

  load(connectionId: string, force = false): Observable<DatabaseSchemaSnapshot> {
    const cached = this.cache.get(connectionId);
    if (cached && !force) {
      this.current.set(cached);
    }
    this.loading.set(true);
    const req = force
      ? this.api.post<DatabaseSchemaSnapshot>(`/databases/${connectionId}/schema/refresh`, {})
      : this.api.get<DatabaseSchemaSnapshot>(`/databases/${connectionId}/schema`);
    return req.pipe(
      tap({
        next: (snapshot) => {
          this.cache.set(connectionId, snapshot);
          this.current.set(snapshot);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      }),
    );
  }

  clear(connectionId: string): void {
    this.cache.delete(connectionId);
    if (this.current()?.connectionId === connectionId) this.current.set(null);
  }
}
