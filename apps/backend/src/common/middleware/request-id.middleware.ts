import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/** Attaches a stable request id used in logs and error responses. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    req.id = incoming && incoming.length <= 100 ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  }
}
