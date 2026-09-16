import { Injectable, inject } from '@angular/core';
import type {
  ExecuteQueryRequest,
  QueryResult,
  SavedQuery,
  SqlValidationResult,
} from '@sqlpilot/shared';
import { Observable } from 'rxjs';
import { ApiService } from '../core/services/api.service';

@Injectable({ providedIn: 'root' })
export class QueryService {
  private readonly api = inject(ApiService);

  validate(connectionId: string, sql: string): Observable<SqlValidationResult> {
    return this.api.post<SqlValidationResult>('/queries/validate', { connectionId, sql });
  }

  execute(payload: ExecuteQueryRequest): Observable<QueryResult> {
    return this.api.post<QueryResult>('/queries/execute', payload);
  }

  save(payload: {
    name: string;
    description?: string;
    sql: string;
    connectionId?: string | null;
    tags?: string[];
  }): Observable<SavedQuery> {
    return this.api.post<SavedQuery>('/queries/save', payload);
  }
}
