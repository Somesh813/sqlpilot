import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LogoComponent } from '../shared/ui/logo.component';
import { ThemeToggleComponent } from '../shared/ui/theme-toggle.component';

@Component({
  selector: 'sp-auth-layout',
  standalone: true,
  imports: [RouterOutlet, LogoComponent, ThemeToggleComponent],
  template: `
    <div class="grid min-h-full lg:grid-cols-2">
      <div class="flex flex-col justify-between p-8 lg:p-12">
        <div class="flex items-center justify-between">
          <sp-logo />
          <sp-theme-toggle />
        </div>
        <div class="mx-auto w-full max-w-sm py-12">
          <router-outlet />
        </div>
        <p class="text-xs text-content-muted">© {{ year }} SQLPilot. Ask your data anything.</p>
      </div>
      <div class="relative hidden overflow-hidden border-l border-surface-border bg-surface-1 lg:block">
        <div class="absolute inset-0 bg-gradient-to-br from-brand-600/10 via-transparent to-transparent"></div>
        <div class="relative flex h-full flex-col justify-center gap-6 p-12">
          <h2 class="text-2xl font-semibold text-content-strong">Natural language in. Safe SQL out.</h2>
          <ul class="space-y-3 text-sm text-content">
            <li>· Schema-aware AI query generation</li>
            <li>· Every query validated before it runs</li>
            <li>· Read-only by default, write access gated by an admin</li>
            <li>· Results, charts, explanations, and optimization in one place</li>
          </ul>
        </div>
      </div>
    </div>
  `,
})
export class AuthLayoutComponent {
  readonly year = new Date().getFullYear();
}
