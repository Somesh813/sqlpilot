import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DatabaseConnectionsModule } from '../database-connections/database-connections.module';
import { SchemaController } from './schema.controller';
import { SchemaService } from './schema.service';
import { SchemaSnapshot, SchemaSnapshotSchema } from './schemas/schema-snapshot.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: SchemaSnapshot.name, schema: SchemaSnapshotSchema }]),
    DatabaseConnectionsModule,
  ],
  controllers: [SchemaController],
  providers: [SchemaService],
  exports: [SchemaService],
})
export class SchemaModule {}
