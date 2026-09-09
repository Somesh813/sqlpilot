import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { ToastService } from '../services/toast.service';

/** Surfaces server errors as toasts, except 401s handled by the auth interceptor. */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);
  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401 && !req.url.includes('/auth/refresh')) {
        const body = error.error as { message?: string | string[] } | null;
        const message = Array.isArray(body?.message)
          ? body?.message.join(', ')
          : body?.message ?? error.message ?? 'Request failed';
        toast.error(message);
      }
      return throwError(() => error);
    }),
  );
};
