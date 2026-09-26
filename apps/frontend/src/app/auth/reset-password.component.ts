import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/services/auth.service';

/** The token arrives in the URL fragment (#token=...), which is never sent to any server. */
function tokenFromFragment(): string {
  const match = /(?:^#|&)token=([0-9a-f]+)/i.exec(window.location.hash);
  return match ? match[1] : '';
}

@Component({
  selector: 'sp-reset-password',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <h1 class="text-xl font-semibold text-content-strong">Choose a new password</h1>

    @if (!token) {
      <p class="mt-6 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-500">
        This reset link is incomplete. Request a new one.
      </p>
    } @else {
      <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()">
        <div>
          <label class="sp-label" for="password">New password</label>
          <input id="password" type="password" class="sp-input" formControlName="password" autocomplete="new-password" />
          <p class="mt-1 text-xs text-content-muted">At least 8 characters with a letter and a number.</p>
        </div>
        @if (error()) {
          <p class="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-500">{{ error() }}</p>
        }
        <button type="submit" class="sp-btn-primary w-full" [disabled]="loading()">
          {{ loading() ? 'Saving…' : 'Set new password' }}
        </button>
      </form>
    }

    <p class="mt-6 text-sm text-content-muted">
      <a routerLink="/forgot-password" class="font-medium text-brand-500 hover:text-brand-400">Request a new link</a>
    </p>
  `,
})
export class ResetPasswordComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly token = tokenFromFragment();
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = this.fb.nonNullable.group({
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  submit(): void {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth.resetPassword(this.token, this.form.getRawValue().password).subscribe({
      next: () => {
        history.replaceState(null, '', window.location.pathname); // drop the token from the address bar
        void this.router.navigate(['/login']);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('This link has expired or was already used. Request a new one.');
      },
    });
  }
}
