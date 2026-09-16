import {
  AiExplanationMode,
  ExplainSqlRequest,
  FixSqlRequest,
  GenerateSqlRequest,
  OptimizeSqlRequest,
} from '@sqlpilot/shared';
import { IsEnum, IsMongoId, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GenerateSqlDto implements GenerateSqlRequest {
  @IsMongoId()
  connectionId!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  question!: string;

  @IsOptional()
  @IsMongoId()
  conversationId?: string;
}

export class ExplainSqlDto implements ExplainSqlRequest {
  @IsMongoId()
  connectionId!: string;

  @IsString()
  @MaxLength(20_000)
  sql!: string;

  @IsEnum(AiExplanationMode)
  mode!: AiExplanationMode;
}

export class OptimizeSqlDto implements OptimizeSqlRequest {
  @IsMongoId()
  connectionId!: string;

  @IsString()
  @MaxLength(20_000)
  sql!: string;
}

export class FixSqlDto implements FixSqlRequest {
  @IsMongoId()
  connectionId!: string;

  @IsString()
  @MaxLength(20_000)
  sql!: string;

  @IsString()
  @MaxLength(4000)
  databaseError!: string;
}
