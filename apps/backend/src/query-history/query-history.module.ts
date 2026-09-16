import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QueryHistoryController } from './query-history.controller';
import { QueryHistoryService } from './query-history.service';
import { QueryHistoryEntry, QueryHistorySchema } from './schemas/query-history.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: QueryHistoryEntry.name, schema: QueryHistorySchema }]),
  ],
  controllers: [QueryHistoryController],
  providers: [QueryHistoryService],
  exports: [QueryHistoryService],
})
export class QueryHistoryModule {}
