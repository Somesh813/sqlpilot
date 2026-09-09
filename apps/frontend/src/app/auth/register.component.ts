import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
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
      </div>
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
          autocomplete="new-password"
        />
        <p class="mt-1.5 text-xs text-content-muted">
          At least 10 characters with an uppercase letter, a lowercase letter, and a number.
        </p>
      </div>

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

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/)]],
  });

  submit(): void {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.auth.register(this.form.getRawValue()).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: () => this.loading.set(false),
    });
  }
}
