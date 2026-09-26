import { HttpException, HttpStatus } from '@nestjs/common';
import { SAFE_MESSAGES, SafeErrorCode, sanitizeTechnical } from '@sqlpilot/shared';

/**
 * An error whose message is safe to show to any user. `detail` is the scrubbed technical line
 * for logs and administrators; it is NOT part of the HTTP response body.
 */
export class SafeException extends HttpException {
  readonly detail: string;

  constructor(
    readonly code: SafeErrorCode,
    status: HttpStatus,
    rawDetail?: unknown,
    /** Extra fields for the response body (all must be safe). */
    extra: Record<string, unknown> = {},
  ) {
    super({ statusCode: status, error: code, code, message: SAFE_MESSAGES[code], ...extra }, status);
    this.detail = rawDetail === undefined ? '' : sanitizeTechnical(rawDetail);
  }

  get safeMessage(): string {
    return SAFE_MESSAGES[this.code];
  }
}

/** Reads the safe code out of any HttpException that carries one. */
export function safeCodeOf(error: unknown): SafeErrorCode | null {
  if (error instanceof SafeException) return error.code;
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const code = (body as { code?: unknown }).code;
      if (typeof code === 'string' && code in SAFE_MESSAGES) return code as SafeErrorCode;
    }
  }
  return null;
}
