import { Injectable, inject } from '@angular/core';
import type { DashboardStats } from '@sqlpilot/shared';
import { Observable, catchError, of } from 'rxjs';
import { ApiService } from '../core/services/api.service';

const EMPTY_STATS: DashboardStats = {
  connectedDatabases: 0,
  totalConnections: 0,
  totalQueries: 0,
  queriesToday: 0,
  aiGeneratedQueries: 0,
  savedQueries: 0,
  successRate: 0,
  avgExecutionTimeMs: 0,
  recentQueries: [],
};

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly api = inject(ApiService);

  /** Analytics land in Phase 9; until then the endpoint may 404 and we show zeros. */
  getStats(): Observable<DashboardStats> {
    return this.api.get<DashboardStats>('/analytics/dashboard').pipe(catchError(() => of(EMPTY_STATS)));
  }
}
