import { Module } from '@nestjs/common';
import { DatabaseConnectionsModule } from '../database-connections/database-connections.module';
import { QueryHistoryModule } from '../query-history/query-history.module';
import { QueryExecutionController } from './query-execution.controller';
import { QueryExecutionService } from './query-execution.service';

@Module({
  imports: [DatabaseConnectionsModule, QueryHistoryModule],
  controllers: [QueryExecutionController],
  providers: [QueryExecutionService],
  exports: [QueryExecutionService],
})
export class QueryExecutionModule {}
