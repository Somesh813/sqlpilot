import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { redactSecrets, SAFE_MESSAGES, sanitizeTechnical } from '@sqlpilot/shared';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as { message?: string | string[]; error?: string; code?: string; status?: string; databaseError?: string | null };
        message = body.message ?? exception.message;
        error = body.error ?? exception.name;
        // Fields deliberately placed in the body by SafeException are safe to pass on.
        if (typeof body.code === 'string') {
          extra = { code: body.code };
          if (body.status !== undefined) extra.status = body.status;
          if (body.databaseError !== undefined) extra.databaseError = body.databaseError;
        }
      }
    } else if (exception instanceof Error) {
      error = exception.name;
    }

    // Framework-generated wording and anything that escaped as a server error is normalised, so
    // an unexpected exception can never carry paths, ids or driver text to the browser.
    if (status === HttpStatus.TOO_MANY_REQUESTS && !(exception instanceof HttpException && typeof (exception.getResponse() as { code?: unknown })?.code === 'string')) {
      message = SAFE_MESSAGES.RATE_LIMITED;
      error = 'RateLimited';
    } else if (status >= 500) {
      const coded = exception instanceof HttpException && typeof (exception.getResponse() as { code?: unknown })?.code === 'string';
      if (!coded) {
        message = 'Something went wrong on our side. Please try again in a moment.';
      } else if (typeof message === 'string') {
        message = sanitizeTechnical(message, 500);
      }
    }

    const payload = {
      statusCode: status,
      error,
      message,
      requestId: request.id,
      path: request.url,
      timestamp: new Date().toISOString(),
      ...extra,
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} [${request.id}] ${redactSecrets(
          exception instanceof Error ? exception.stack ?? exception.message : String(exception),
        )}`,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status} [${request.id}]`);
    }

    response.status(status).json(payload);
  }
}
