import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/services/auth.service';
import { LogoComponent } from '../shared/ui/logo.component';
import { ThemeToggleComponent } from '../shared/ui/theme-toggle.component';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'sp-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LogoComponent, ThemeToggleComponent],
  template: `
    <div class="flex h-full">
      <aside
        class="fixed inset-y-0 left-0 z-30 w-64 -translate-x-full border-r border-surface-border bg-surface-1 transition-transform lg:static lg:translate-x-0"
        [class.translate-x-0]="sidebarOpen()"
      >
        <div class="flex h-16 items-center gap-2 border-b border-surface-border px-5">
          <sp-logo />
        </div>
        <nav class="flex flex-col gap-1 p-3">
          @for (item of nav; track item.path) {
            <a
              [routerLink]="item.path"
              routerLinkActive="bg-surface-2 text-content-strong"
              (click)="sidebarOpen.set(false)"
              class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-content hover:bg-surface-2"
            >
              <span class="text-base">{{ item.icon }}</span>
              {{ item.label }}
            </a>
          }
        </nav>
      </aside>

      @if (sidebarOpen()) {
        <div class="fixed inset-0 z-20 bg-black/40 lg:hidden" (click)="sidebarOpen.set(false)"></div>
      }

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-16 items-center justify-between gap-4 border-b border-surface-border bg-surface-0 px-4 lg:px-6">
          <button
            class="grid h-9 w-9 place-items-center rounded-xl border border-surface-border lg:hidden"
            (click)="sidebarOpen.set(!sidebarOpen())"
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <div class="flex flex-1 items-center"></div>
          <div class="flex items-center gap-3">
            <sp-theme-toggle />
            <div class="flex items-center gap-2 rounded-xl border border-surface-border bg-surface-1 py-1.5 pl-3 pr-1.5">
              <div class="text-right">
                <p class="text-sm font-medium text-content-strong">{{ auth.user()?.name }}</p>
                <p class="text-xs text-content-muted">{{ auth.user()?.role }}</p>
              </div>
              <button
                class="rounded-lg border border-surface-border px-2.5 py-1 text-xs text-content hover:bg-surface-2"
                (click)="logout()"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>

        <main class="sp-scroll min-h-0 flex-1 overflow-y-auto bg-surface-0">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
})
export class ShellComponent {
  readonly auth = inject(AuthService);
  readonly sidebarOpen = signal(false);

  readonly nav: NavItem[] = [
    { path: '/dashboard', label: 'Dashboard', icon: '◧' },
    { path: '/assistant', label: 'AI Assistant', icon: '✦' },
    { path: '/connections', label: 'Connections', icon: '⛁' },
    { path: '/history', label: 'Query History', icon: '↺' },
    { path: '/saved', label: 'Saved Queries', icon: '★' },
    { path: '/settings', label: 'Settings', icon: '⚙' },
  ];

  logout(): void {
    void this.auth.logout();
  }
}
