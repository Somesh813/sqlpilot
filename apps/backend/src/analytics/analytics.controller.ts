import { Controller, Get } from '@nestjs/common';
import { DashboardStats } from '@sqlpilot/shared';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthenticatedUser): Promise<DashboardStats> {
    return this.analytics.getDashboard(user.id);
  }
}
