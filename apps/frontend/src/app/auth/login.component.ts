import { Component, inject, signal } from '@angular/core';
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
      </div>

      <button type="submit" class="sp-btn-primary w-full" [disabled]="loading()">
        {{ loading() ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>

    <p class="mt-6 text-sm text-content-muted">
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

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  submit(): void {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.auth.login(this.form.getRawValue()).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: () => this.loading.set(false),
    });
  }
}
