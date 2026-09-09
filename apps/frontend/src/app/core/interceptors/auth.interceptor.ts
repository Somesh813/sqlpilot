import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { BehaviorSubject, catchError, filter, switchMap, take, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth.service';
import { TokenStorageService } from '../services/token-storage.service';

let refreshing = false;
const refreshed$ = new BehaviorSubject<string | null>(null);

/** Attaches the bearer token and transparently refreshes it on a 401. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const tokens = inject(TokenStorageService);
  const auth = inject(AuthService);

  const isApi = req.url.startsWith(environment.apiBaseUrl);
  const isAuthCall = req.url.includes('/auth/login') || req.url.includes('/auth/register') || req.url.includes('/auth/refresh');

  const withToken = (token: string | null) =>
    token && isApi ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(withToken(tokens.accessToken)).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401 || !isApi || isAuthCall || !tokens.refreshToken) {
        return throwError(() => error);
      }

      if (refreshing) {
        return refreshed$.pipe(
          filter((t): t is string => t !== null),
          take(1),
          switchMap((t) => next(withToken(t))),
        );
      }

      refreshing = true;
      refreshed$.next(null);
      return auth.refresh().pipe(
        switchMap((res) => {
          refreshing = false;
          refreshed$.next(res.accessToken);
          return next(withToken(res.accessToken));
        }),
        catchError((refreshError) => {
          refreshing = false;
          void auth.logout();
          return throwError(() => refreshError);
        }),
      );
    }),
  );
};
