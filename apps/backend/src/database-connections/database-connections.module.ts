import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DatabaseConnectionsController } from './database-connections.controller';
import { DatabaseConnectionsService } from './database-connections.service';
import { DriverPoolService } from './driver-pool.service';
import {
  DatabaseConnection,
  DatabaseConnectionSchema,
} from './schemas/database-connection.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DatabaseConnection.name, schema: DatabaseConnectionSchema },
    ]),
  ],
  controllers: [DatabaseConnectionsController],
  providers: [DatabaseConnectionsService, DriverPoolService],
  exports: [DatabaseConnectionsService, DriverPoolService],
})
export class DatabaseConnectionsModule {}
