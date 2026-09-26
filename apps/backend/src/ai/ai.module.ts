import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationsModule } from '../conversations/conversations.module';
import { DatabaseConnectionsModule } from '../database-connections/database-connections.module';
import { SchemaModule } from '../schema/schema.module';
import { AI_PROVIDER, aiProviderFactory } from './ai-provider.factory';
import { AiController } from './ai.controller';
import { AiSqlService } from './ai-sql.service';
import { AskService } from './ask.service';
import { QueryExecutionModule } from '../query-execution/query-execution.module';

@Module({
  imports: [SchemaModule, DatabaseConnectionsModule, ConversationsModule, QueryExecutionModule],
  controllers: [AiController],
  providers: [
    { provide: AI_PROVIDER, useFactory: aiProviderFactory, inject: [ConfigService] },
    AiSqlService,
    AskService,
  ],
  exports: [AiSqlService],
})
export class AiModule {}
