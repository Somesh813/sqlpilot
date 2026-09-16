import { Injectable, inject } from '@angular/core';
import type { SavedQuery } from '@sqlpilot/shared';
import { Observable } from 'rxjs';
import { ApiService } from '../core/services/api.service';

@Injectable({ providedIn: 'root' })
export class SavedQueriesApiService {
  private readonly api = inject(ApiService);

  list(search?: string): Observable<SavedQuery[]> {
    return this.api.get<SavedQuery[]>('/queries/saved', { search });
  }

  update(
    id: string,
    payload: Partial<Pick<SavedQuery, 'name' | 'description' | 'sql' | 'tags'>>,
  ): Observable<SavedQuery> {
    return this.api.patch<SavedQuery>(`/queries/saved/${id}`, payload);
  }

  remove(id: string): Observable<void> {
    return this.api.delete<void>(`/queries/saved/${id}`);
  }
}
