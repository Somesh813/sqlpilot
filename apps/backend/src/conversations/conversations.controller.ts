import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Conversation, ConversationMessage } from '@sqlpilot/shared';
import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ConversationsService } from './conversations.service';

class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsMongoId()
  connectionId?: string;
}

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<Conversation[]> {
    return this.conversations.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateConversationDto,
  ): Promise<Conversation> {
    return this.conversations.create(user.id, { title: dto.title, connectionId: dto.connectionId });
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
    return this.conversations.getWithMessages(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.conversations.remove(user.id, id);
  }
}
