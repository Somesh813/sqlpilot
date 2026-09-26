import { HttpStatus } from '@nestjs/common';
import { AiProviderError } from '@sqlpilot/ai';
import { SafeErrorCode } from '@sqlpilot/shared';
import { SafeException } from './safe-exception';

const MAP: Record<AiProviderError['code'], { code: SafeErrorCode; status: HttpStatus }> = {
  RATE_LIMITED: { code: 'AI_BUSY', status: HttpStatus.TOO_MANY_REQUESTS },
  TIMEOUT: { code: 'AI_TIMEOUT', status: HttpStatus.SERVICE_UNAVAILABLE },
  UNAVAILABLE: { code: 'AI_UNAVAILABLE', status: HttpStatus.SERVICE_UNAVAILABLE },
  NOT_CONFIGURED: { code: 'AI_NOT_CONFIGURED', status: HttpStatus.SERVICE_UNAVAILABLE },
  BAD_RESPONSE: { code: 'AI_BAD_RESPONSE', status: HttpStatus.BAD_GATEWAY },
  UNKNOWN: { code: 'AI_UNAVAILABLE', status: HttpStatus.SERVICE_UNAVAILABLE },
};

/**
 * Provider failure -> exception with a user-safe message. The technical detail is a coded line
 * ("AI provider error: RATE_LIMITED (HTTP 429)"), never the provider's own text.
 */
export function aiErrorToSafe(error: AiProviderError): SafeException {
  const { code, status } = MAP[error.code] ?? MAP.UNKNOWN;
  const detail = `AI provider error: ${error.code}${error.status ? ` (HTTP ${error.status})` : ''}`;
  return new SafeException(code, status, detail);
}
