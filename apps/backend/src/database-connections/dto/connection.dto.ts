import { CreateConnectionRequest, DatabaseType, UpdateConnectionRequest } from '@sqlpilot/shared';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateConnectionDto implements CreateConnectionRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsEnum(DatabaseType)
  type!: DatabaseType;

  // Host/port/credentials required for postgres + mysql, ignored for sqlite.
  @ValidateIf((o: CreateConnectionDto) => o.type !== DatabaseType.SQLITE)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host?: string;

  @ValidateIf((o: CreateConnectionDto) => o.type !== DatabaseType.SQLITE)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ValidateIf((o: CreateConnectionDto) => o.type !== DatabaseType.SQLITE)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  username?: string;

  @ValidateIf((o: CreateConnectionDto) => o.type !== DatabaseType.SQLITE)
  @IsString()
  @MaxLength(512)
  password?: string;

  // database name (pg/mysql) OR logical name for sqlite
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  database!: string;

  @ValidateIf((o: CreateConnectionDto) => o.type === DatabaseType.SQLITE)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  filePath?: string;

  @IsOptional()
  @IsBoolean()
  ssl?: boolean;

  @IsOptional()
  @IsObject()
  options?: Record<string, string | number | boolean>;
}

export class UpdateConnectionDto implements UpdateConnectionRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  database?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  filePath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;

  @IsOptional()
  @IsBoolean()
  ssl?: boolean;

  @IsOptional()
  @IsObject()
  options?: Record<string, string | number | boolean>;
}

/** Ad-hoc "test before save" — same shape as create. */
export class TestConnectionDto extends CreateConnectionDto {}
