import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PromptTemplate, SavedQuery } from '@sqlpilot/shared';
import {
  IsArray,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { SavedQueriesService } from './saved-queries.service';

class SaveQueryDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @MinLength(1) @MaxLength(20_000) sql!: string;
  @IsOptional() @IsMongoId() connectionId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class UpdateSavedQueryDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(20_000) sql?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class CreatePromptDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @MinLength(1) @MaxLength(8000) body!: string;
}

@Controller()
export class SavedQueriesController {
  constructor(private readonly saved: SavedQueriesService) {}

  @Get('queries/saved')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
  ): Promise<SavedQuery[]> {
    return this.saved.list(user.id, search);
  }

  @Post('queries/save')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: SaveQueryDto): Promise<SavedQuery> {
    return this.saved.create(user.id, dto);
  }

  @Patch('queries/saved/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSavedQueryDto,
  ): Promise<SavedQuery> {
    return this.saved.update(user.id, id, dto);
  }

  @Delete('queries/saved/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.saved.remove(user.id, id);
  }

  @Get('prompts')
  listPrompts(@CurrentUser() user: AuthenticatedUser): Promise<PromptTemplate[]> {
    return this.saved.listPrompts(user.id);
  }

  @Post('prompts')
  createPrompt(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePromptDto,
  ): Promise<PromptTemplate> {
    return this.saved.createPrompt(user.id, dto);
  }

  @Delete('prompts/:id')
  @HttpCode(204)
  async removePrompt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.saved.removePrompt(user.id, id);
  }
}
