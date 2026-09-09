import { Injectable } from '@angular/core';
import type { AuthTokens } from '@sqlpilot/shared';

const ACCESS_KEY = 'sqlpilot.accessToken';
const REFRESH_KEY = 'sqlpilot.refreshToken';

/**
 * Tokens are held in localStorage for this build. For higher security, move the
 * refresh token to an httpOnly cookie issued by the API.
 */
@Injectable({ providedIn: 'root' })
export class TokenStorageService {
  get accessToken(): string | null {
    return this.read(ACCESS_KEY);
  }

  get refreshToken(): string | null {
    return this.read(REFRESH_KEY);
  }

  set(tokens: Pick<AuthTokens, 'accessToken' | 'refreshToken'>): void {
    this.write(ACCESS_KEY, tokens.accessToken);
    this.write(REFRESH_KEY, tokens.refreshToken);
  }

  clear(): void {
    this.write(ACCESS_KEY, null);
    this.write(REFRESH_KEY, null);
  }

  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private write(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  }
}
