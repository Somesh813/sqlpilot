import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type {
  AuthResponse,
  ChangePasswordRequest,
  LoginRequest,
  RegisterRequest,
  User,
} from '@sqlpilot/shared';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import { TokenStorageService } from './token-storage.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly tokens = inject(TokenStorageService);
  private readonly router = inject(Router);

  private readonly _user = signal<AuthResponse['user'] | null>(null);
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly isAdmin = computed(() => this._user()?.role === 'ADMIN');

  /** True once the initial session restore attempt has completed. */
  readonly ready = signal(false);

  hasStoredSession(): boolean {
    return this.tokens.accessToken !== null;
  }

  register(payload: RegisterRequest): Observable<AuthResponse> {
    return this.api.post<AuthResponse>('/auth/register', payload).pipe(tap((r) => this.applySession(r)));
  }

  login(payload: LoginRequest): Observable<AuthResponse> {
    return this.api.post<AuthResponse>('/auth/login', payload).pipe(tap((r) => this.applySession(r)));
  }

  loadProfile(): Observable<User> {
    return this.api.get<User>('/auth/profile').pipe(
      tap((user) => {
        this._user.set({ id: user.id, name: user.name, email: user.email, role: user.role });
        this.ready.set(true);
      }),
    );
  }

  changePassword(payload: ChangePasswordRequest): Observable<void> {
    return this.api.post<void>('/auth/change-password', payload);
  }

  refresh(): Observable<AuthResponse> {
    return this.api
      .post<AuthResponse>('/auth/refresh', { refreshToken: this.tokens.refreshToken })
      .pipe(tap((r) => this.applySession(r)));
  }

  async logout(navigate = true): Promise<void> {
    const refreshToken = this.tokens.refreshToken;
    if (refreshToken) {
      try {
        await this.api.post('/auth/logout', { refreshToken }).toPromise();
      } catch {
        /* best effort */
      }
    }
    this.tokens.clear();
    this._user.set(null);
    if (navigate) await this.router.navigate(['/login']);
  }

  private applySession(response: AuthResponse): void {
    this.tokens.set(response);
    this._user.set(response.user);
    this.ready.set(true);
  }
}
