import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../core/services/auth.service';

@Component({
  selector: 'sp-forgot-password',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <h1 class="text-xl font-semibold text-content-strong">Reset your password</h1>
    <p class="mt-1 text-sm text-content-muted">Enter your email and we will send you a reset link.</p>

    @if (sent()) {
      <p class="mt-8 rounded-lg border border-surface-border bg-surface-1 px-3 py-3 text-sm text-content-strong" data-testid="sent">
        If an account exists for that email, a reset link is on its way. The link works for one hour.
      </p>
    } @else {
      <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()">
        <div>
          <label class="sp-label" for="email">Email</label>
          <input id="email" type="email" class="sp-input" formControlName="email" autocomplete="email" />
          @if (form.controls.email.invalid && form.controls.email.touched) {
            <p class="mt-1 text-xs text-red-500">Enter a valid email address.</p>
          }
        </div>
        <button type="submit" class="sp-btn-primary w-full" [disabled]="loading()">
          {{ loading() ? 'Sending…' : 'Send reset link' }}
        </button>
      </form>
    }

    <p class="mt-6 text-sm text-content-muted">
      <a routerLink="/login" class="font-medium text-brand-500 hover:text-brand-400">Back to sign in</a>
    </p>
  `,
})
export class ForgotPasswordComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly sent = signal(false);
  readonly form = this.fb.nonNullable.group({ email: ['', [Validators.required, Validators.email]] });

  submit(): void {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    // The answer is the same whether or not the account exists, and so is what we show.
    this.auth.forgotPassword(this.form.getRawValue().email).subscribe({
      next: () => this.done(),
      error: () => this.done(),
    });
  }

  private done(): void {
    this.loading.set(false);
    this.sent.set(true);
  }
}
