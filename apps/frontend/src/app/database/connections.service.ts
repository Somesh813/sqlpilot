import { Injectable, inject, signal } from '@angular/core';
import type {
  CreateConnectionRequest,
  SafeDatabaseConnection,
  TestConnectionResult,
  UpdateConnectionRequest,
} from '@sqlpilot/shared';
import { Observable, tap } from 'rxjs';
import { ApiService } from '../core/services/api.service';

@Injectable({ providedIn: 'root' })
export class ConnectionsService {
  private readonly api = inject(ApiService);

  readonly connections = signal<SafeDatabaseConnection[]>([]);
  readonly loaded = signal(false);

  load(): Observable<SafeDatabaseConnection[]> {
    return this.api.get<SafeDatabaseConnection[]>('/databases').pipe(
      tap((list) => {
        this.connections.set(list);
        this.loaded.set(true);
      }),
    );
  }

  create(payload: CreateConnectionRequest): Observable<SafeDatabaseConnection> {
    return this.api
      .post<SafeDatabaseConnection>('/databases', payload)
      .pipe(tap((created) => this.connections.update((list) => [created, ...list])));
  }

  update(id: string, payload: UpdateConnectionRequest): Observable<SafeDatabaseConnection> {
    return this.api
      .patch<SafeDatabaseConnection>(`/databases/${id}`, payload)
      .pipe(tap((updated) => this.connections.update((list) => list.map((c) => (c.id === id ? updated : c)))));
  }

  remove(id: string): Observable<void> {
    return this.api
      .delete<void>(`/databases/${id}`)
      .pipe(tap(() => this.connections.update((list) => list.filter((c) => c.id !== id))));
  }

  testNew(payload: CreateConnectionRequest): Observable<TestConnectionResult> {
    return this.api.post<TestConnectionResult>('/databases/test', payload);
  }

  testExisting(id: string): Observable<TestConnectionResult> {
    return this.api.post<TestConnectionResult>(`/databases/${id}/test`, {}).pipe(
      tap(() => {
        // refresh the row so its status badge updates
        this.load().subscribe();
      }),
    );
  }
}
