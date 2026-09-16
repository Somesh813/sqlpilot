import { Injectable, inject } from '@angular/core';
import type { Paginated, QueryHistoryEntry, QueryStatus } from '@sqlpilot/shared';
import { Observable } from 'rxjs';
import { ApiService } from '../core/services/api.service';

@Injectable({ providedIn: 'root' })
export class QueryHistoryApiService {
  private readonly api = inject(ApiService);

  list(params: {
    page?: number;
    pageSize?: number;
    connectionId?: string;
    status?: QueryStatus;
    search?: string;
  }): Observable<Paginated<QueryHistoryEntry>> {
    return this.api.get<Paginated<QueryHistoryEntry>>('/queries/history', params);
  }

  remove(id: string): Observable<void> {
    return this.api.delete<void>(`/queries/history/${id}`);
  }
}
