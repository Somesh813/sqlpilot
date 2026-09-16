import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConnectionStatus, DashboardStats, QueryStatus } from '@sqlpilot/shared';
import { Model, Types } from 'mongoose';
import {
  DatabaseConnection,
  DatabaseConnectionDocument,
} from '../database-connections/schemas/database-connection.schema';
import {
  QueryHistoryDocument,
  QueryHistoryEntry,
} from '../query-history/schemas/query-history.schema';
import { SavedQuery, SavedQueryDocument } from '../saved-queries/schemas/saved-query.schema';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(QueryHistoryEntry.name) private readonly history: Model<QueryHistoryDocument>,
    @InjectModel(DatabaseConnection.name) private readonly connections: Model<DatabaseConnectionDocument>,
    @InjectModel(SavedQuery.name) private readonly saved: Model<SavedQueryDocument>,
  ) {}

  async getDashboard(userId: string): Promise<DashboardStats> {
    const uid = new Types.ObjectId(userId);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      totalConnections,
      connectedDatabases,
      totalQueries,
      queriesToday,
      aiGeneratedQueries,
      savedQueries,
      statusAgg,
      timeAgg,
      recent,
    ] = await Promise.all([
      this.connections.countDocuments({ userId: uid }),
      this.connections.countDocuments({ userId: uid, status: ConnectionStatus.CONNECTED }),
      this.history.countDocuments({ userId: uid }),
      this.history.countDocuments({ userId: uid, createdAt: { $gte: startOfToday } }),
      this.history.countDocuments({ userId: uid, aiGenerated: true }),
      this.saved.countDocuments({ userId: uid }),
      this.history.aggregate<{ _id: QueryStatus; count: number }>([
        { $match: { userId: uid } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.history.aggregate<{ _id: null; avg: number }>([
        { $match: { userId: uid, status: QueryStatus.SUCCESS, executionTimeMs: { $ne: null } } },
        { $group: { _id: null, avg: { $avg: '$executionTimeMs' } } },
      ]),
      this.history
        .find({ userId: uid })
        .sort({ createdAt: -1 })
        .limit(8)
        .exec(),
    ]);

    const byStatus = new Map(statusAgg.map((s) => [s._id, s.count]));
    const success = byStatus.get(QueryStatus.SUCCESS) ?? 0;
    const executed =
      success +
      (byStatus.get(QueryStatus.ERROR) ?? 0) +
      (byStatus.get(QueryStatus.TIMEOUT) ?? 0);

    return {
      connectedDatabases,
      totalConnections,
      totalQueries,
      queriesToday,
      aiGeneratedQueries,
      savedQueries,
      successRate: executed === 0 ? 0 : Number((success / executed).toFixed(3)),
      avgExecutionTimeMs: Math.round(timeAgg[0]?.avg ?? 0),
      recentQueries: recent.map((r) => ({
        id: r.id,
        sql: r.sql,
        prompt: r.prompt,
        status: r.status,
        connectionName: r.connectionName,
        createdAt: (r as unknown as { createdAt: Date }).createdAt.toISOString(),
      })),
    };
  }
}
