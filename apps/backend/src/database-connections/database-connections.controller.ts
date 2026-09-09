import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { SafeDatabaseConnection, TestConnectionResult } from '@sqlpilot/shared';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { DatabaseConnectionsService } from './database-connections.service';
import {
  CreateConnectionDto,
  TestConnectionDto,
  UpdateConnectionDto,
} from './dto/connection.dto';

function ctx(req: Request): { requestId: string | null; ip: string | null } {
  const id = (req as { id?: string | number }).id;
  return { requestId: id !== undefined ? String(id) : null, ip: req.ip ?? null };
}

@Controller('databases')
export class DatabaseConnectionsController {
  constructor(private readonly connections: DatabaseConnectionsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<SafeDatabaseConnection[]> {
    return this.connections.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateConnectionDto,
    @Req() req: Request,
  ): Promise<SafeDatabaseConnection> {
    return this.connections.create(user.id, dto, ctx(req));
  }

  @Post('test')
  @HttpCode(200)
  test(@Body() dto: TestConnectionDto): Promise<TestConnectionResult> {
    return this.connections.testAdHoc(dto);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<SafeDatabaseConnection> {
    return this.connections.get(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateConnectionDto,
    @Req() req: Request,
  ): Promise<SafeDatabaseConnection> {
    return this.connections.update(user.id, id, dto, ctx(req));
  }

  @Post(':id/test')
  @HttpCode(200)
  testExisting(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<TestConnectionResult> {
    return this.connections.testExisting(user.id, id, ctx(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.connections.remove(user.id, id, ctx(req));
  }
}
