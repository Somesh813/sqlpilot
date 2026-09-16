import { Controller, Delete, Get, HttpCode, Param, Query } from '@nestjs/common';
import { Paginated, QueryHistoryEntry, QueryStatus } from '@sqlpilot/shared';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { QueryHistoryService } from './query-history.service';

@Controller('queries/history')
export class QueryHistoryController {
  constructor(private readonly history: QueryHistoryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('connectionId') connectionId?: string,
    @Query('status') status?: QueryStatus,
    @Query('search') search?: string,
  ): Promise<Paginated<QueryHistoryEntry>> {
    return this.history.list(user.id, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      connectionId,
      status,
      search,
    });
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<QueryHistoryEntry> {
    return this.history.get(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.history.remove(user.id, id);
  }
}
