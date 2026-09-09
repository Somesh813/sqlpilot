import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../core/services/auth.service';
import { ThemeService } from '../core/services/theme.service';
import { ToastService } from '../core/services/toast.service';
import { PageComponent } from '../shared/ui/page.component';

@Component({
  selector: 'sp-settings',
  standalone: true,
  imports: [PageComponent, ReactiveFormsModule],
  template: `
    <sp-page title="Settings" subtitle="Manage your account and appearance.">
      <div class="grid gap-6 lg:grid-cols-2">
        <section class="sp-card p-5">
          <h2 class="text-sm font-semibold text-content-strong">Profile</h2>
          <dl class="mt-4 space-y-2 text-sm">
            <div class="flex justify-between"><dt class="text-content-muted">Name</dt><dd>{{ auth.user()?.name }}</dd></div>
            <div class="flex justify-between"><dt class="text-content-muted">Email</dt><dd>{{ auth.user()?.email }}</dd></div>
            <div class="flex justify-between"><dt class="text-content-muted">Role</dt><dd>{{ auth.user()?.role }}</dd></div>
          </dl>
        </section>

        <section class="sp-card p-5">
          <h2 class="text-sm font-semibold text-content-strong">Appearance</h2>
          <div class="mt-4 flex items-center justify-between">
            <span class="text-sm text-content">Theme</span>
            <div class="flex gap-2">
              <button
                class="rounded-lg border border-surface-border px-3 py-1.5 text-sm"
                [class.bg-surface-2]="theme.mode() === 'light'"
                (click)="theme.mode.set('light')"
              >
                Light
              </button>
              <button
                class="rounded-lg border border-surface-border px-3 py-1.5 text-sm"
                [class.bg-surface-2]="theme.mode() === 'dark'"
                (click)="theme.mode.set('dark')"
              >
                Dark
              </button>
            </div>
          </div>
        </section>

        <section class="sp-card p-5 lg:col-span-2">
          <h2 class="text-sm font-semibold text-content-strong">Change password</h2>
          <form class="mt-4 grid gap-4 sm:grid-cols-2" [formGroup]="form" (ngSubmit)="submit()">
            <div>
              <label class="sp-label" for="current">Current password</label>
              <input id="current" type="password" class="sp-input" formControlName="currentPassword" />
            </div>
            <div>
              <label class="sp-label" for="next">New password</label>
              <input id="next" type="password" class="sp-input" formControlName="newPassword" />
            </div>
            <div class="sm:col-span-2">
              <button class="sp-btn-primary" [disabled]="saving()">
                {{ saving() ? 'Saving…' : 'Update password' }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </sp-page>
  `,
})
export class SettingsComponent {
  private readonly fb = inject(FormBuilder);
  readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);
  private readonly toast = inject(ToastService);

  readonly saving = signal(false);

  readonly form = this.fb.nonNullable.group({
    currentPassword: ['', [Validators.required]],
    newPassword: ['', [Validators.required, Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/)]],
  });

  submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.auth.changePassword(this.form.getRawValue()).subscribe({
      next: () => {
        this.toast.success('Password updated. Please sign in again on other devices.');
        this.form.reset();
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }
}
