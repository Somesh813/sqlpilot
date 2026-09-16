import { Injectable, inject } from '@angular/core';
import type {
  Conversation,
  ConversationMessage,
  GeneratedSql,
  SqlExplanation,
  SqlFix,
  SqlOptimization,
} from '@sqlpilot/shared';
import { Observable } from 'rxjs';
import { ApiService } from '../core/services/api.service';

@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly api = inject(ApiService);

  generateSql(connectionId: string, question: string, conversationId?: string): Observable<GeneratedSql> {
    return this.api.post<GeneratedSql>('/ai/generate-sql', { connectionId, question, conversationId });
  }

  explainSql(connectionId: string, sql: string, mode: 'simple' | 'technical'): Observable<SqlExplanation> {
    return this.api.post<SqlExplanation>('/ai/explain-sql', { connectionId, sql, mode });
  }

  optimizeSql(connectionId: string, sql: string): Observable<SqlOptimization> {
    return this.api.post<SqlOptimization>('/ai/optimize-sql', { connectionId, sql });
  }

  fixSql(connectionId: string, sql: string, databaseError: string): Observable<SqlFix> {
    return this.api.post<SqlFix>('/ai/fix-sql', { connectionId, sql, databaseError });
  }

  listConversations(): Observable<Conversation[]> {
    return this.api.get<Conversation[]>('/conversations');
  }

  createConversation(connectionId?: string | null): Observable<Conversation> {
    return this.api.post<Conversation>('/conversations', { connectionId: connectionId ?? undefined });
  }

  getConversation(id: string): Observable<{ conversation: Conversation; messages: ConversationMessage[] }> {
    return this.api.get<{ conversation: Conversation; messages: ConversationMessage[] }>(`/conversations/${id}`);
  }

  deleteConversation(id: string): Observable<void> {
    return this.api.delete<void>(`/conversations/${id}`);
  }
}
