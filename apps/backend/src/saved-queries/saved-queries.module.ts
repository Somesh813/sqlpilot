import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SavedQueriesController } from './saved-queries.controller';
import { SavedQueriesService } from './saved-queries.service';
import {
  PromptTemplate,
  PromptTemplateSchema,
  SavedQuery,
  SavedQuerySchema,
} from './schemas/saved-query.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SavedQuery.name, schema: SavedQuerySchema },
      { name: PromptTemplate.name, schema: PromptTemplateSchema },
    ]),
  ],
  controllers: [SavedQueriesController],
  providers: [SavedQueriesService],
  exports: [SavedQueriesService],
})
export class SavedQueriesModule {}
