import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/services/auth.service';

@Component({
  selector: 'sp-register',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <h1 class="text-xl font-semibold text-content-strong">Create your account</h1>
    <p class="mt-1 text-sm text-content-muted">Start asking your databases questions in plain English.</p>

    <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()">
      <div>
        <label class="sp-label" for="name">Name</label>
        <input id="name" class="sp-input" formControlName="name" autocomplete="name" />
        @if (showError('name')) {
          <p class="mt-1 text-xs text-red-500">Enter your name.</p>
        }
      </div>
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
          autocomplete="new-password"
        />
        <p
          class="mt-1.5 text-xs"
          [class.text-content-muted]="!showError('password')"
          [class.text-red-500]="showError('password')"
        >
          At least 10 characters with an uppercase letter, a lowercase letter, and a number.
        </p>
      </div>

      @if (serverError()) {
        <p class="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-500">
          {{ serverError() }}
        </p>
      }

      <button type="submit" class="sp-btn-primary w-full" [disabled]="loading()">
        {{ loading() ? 'Creating account…' : 'Create account' }}
      </button>
    </form>

    <p class="mt-6 text-sm text-content-muted">
      Already have an account?
      <a routerLink="/login" class="font-medium text-brand-500 hover:text-brand-400">Sign in</a>
    </p>
  `,
})
export class RegisterComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/)]],
  });

  showError(control: 'name' | 'email' | 'password'): boolean {
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
    this.auth.register(this.form.getRawValue()).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.serverError.set(messageFrom(err));
      },
    });
  }
}

function messageFrom(err: HttpErrorResponse): string {
  if (err.status === 0) {
    return 'Could not reach the server. Make sure the API is running on port 3000.';
  }
  const body = err.error as { message?: string | string[] } | null;
  if (Array.isArray(body?.message)) return body.message.join(' ');
  return body?.message ?? 'Registration failed. Please try again.';
}
