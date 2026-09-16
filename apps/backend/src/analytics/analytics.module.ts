import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DatabaseConnection,
  DatabaseConnectionSchema,
} from '../database-connections/schemas/database-connection.schema';
import {
  QueryHistoryEntry,
  QueryHistorySchema,
} from '../query-history/schemas/query-history.schema';
import { SavedQuery, SavedQuerySchema } from '../saved-queries/schemas/saved-query.schema';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: QueryHistoryEntry.name, schema: QueryHistorySchema },
      { name: DatabaseConnection.name, schema: DatabaseConnectionSchema },
      { name: SavedQuery.name, schema: SavedQuerySchema },
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
