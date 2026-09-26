import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/services/auth.service';

@Component({
  selector: 'sp-login',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <h1 class="text-xl font-semibold text-content-strong">Sign in to SQLPilot</h1>
    <p class="mt-1 text-sm text-content-muted">Welcome back. Enter your details to continue.</p>

    <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()">
      <div>
        <label class="sp-label" for="email">Email</label>
        <input id="email" type="email" class="sp-input" formControlName="email" autocomplete="email" />
        @if (showError('email')) {
          <p class="mt-1 text-xs text-red-500">Enter a valid email address.</p>
        }
      </div>
      <div>
        <label class="sp-label" for="password">Password</label>
        <input
          id="password"
          type="password"
          class="sp-input"
          formControlName="password"
          autocomplete="current-password"
        />
        @if (showError('password')) {
          <p class="mt-1 text-xs text-red-500">Enter your password.</p>
        }
      </div>

      @if (serverError()) {
        <p class="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-500">
          {{ serverError() }}
        </p>
      }

      <button type="submit" class="sp-btn-primary w-full" [disabled]="loading()">
        {{ loading() ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>

    <p class="mt-4 text-sm">
      <a routerLink="/forgot-password" class="text-content-muted hover:text-content-strong">Forgot your password?</a>
    </p>
    <p class="mt-2 text-sm text-content-muted">
      No account?
      <a routerLink="/register" class="font-medium text-brand-500 hover:text-brand-400">Create one</a>
    </p>
  `,
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  showError(control: 'email' | 'password'): boolean {
    const c = this.form.controls[control];
    return c.invalid && (c.touched || c.dirty);
  }

  submit(): void {
    this.serverError.set(null);
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.auth.login(this.form.getRawValue()).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.serverError.set(
          err.status === 0
            ? 'Could not reach the server. Make sure the API is running on port 3000.'
            : err.status === 401
              ? 'Invalid email or password.'
              : 'Sign in failed. Please try again.',
        );
      },
    });
  }
}
