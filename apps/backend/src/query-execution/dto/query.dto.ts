import { ExecuteQueryRequest, ValidateQueryRequest } from '@sqlpilot/shared';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

const MAX_SQL_LENGTH = 20_000;

export class ValidateQueryDto implements ValidateQueryRequest {
  @IsMongoId()
  connectionId!: string;

  @IsString()
  @MaxLength(MAX_SQL_LENGTH)
  sql!: string;
}

export class ExecuteQueryDto implements ExecuteQueryRequest {
  @IsMongoId()
  connectionId!: string;

  @IsString()
  @MaxLength(MAX_SQL_LENGTH)
  sql!: string;

  @IsBoolean()
  confirmed!: boolean;

  @IsOptional()
  @IsMongoId()
  conversationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  prompt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsBoolean()
  aiGenerated?: boolean;
}
