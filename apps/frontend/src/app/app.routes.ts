import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: '',
    canActivate: [guestGuard],
    loadComponent: () => import('./layout/auth-layout.component').then((m) => m.AuthLayoutComponent),
    children: [
      {
        path: 'login',
        loadComponent: () => import('./auth/login.component').then((m) => m.LoginComponent),
      },
      {
        path: 'forgot-password',
        loadComponent: () => import('./auth/forgot-password.component').then((m) => m.ForgotPasswordComponent),
      },
      {
        path: 'reset-password',
        loadComponent: () => import('./auth/reset-password.component').then((m) => m.ResetPasswordComponent),
      },
      {
        path: 'register',
        loadComponent: () => import('./auth/register.component').then((m) => m.RegisterComponent),
      },
    ],
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell.component').then((m) => m.ShellComponent),
    children: [
      {
        path: 'dashboard',
        loadComponent: () => import('./dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'connections',
        loadComponent: () =>
          import('./database/connections.component').then((m) => m.ConnectionsComponent),
      },
      {
        path: 'assistant',
        loadComponent: () => import('./workspace/workspace.component').then((m) => m.WorkspaceComponent),
      },
      {
        path: 'history',
        loadComponent: () =>
          import('./query-history/query-history.component').then((m) => m.QueryHistoryComponent),
      },
      {
        path: 'saved',
        loadComponent: () =>
          import('./saved-queries/saved-queries.component').then((m) => m.SavedQueriesComponent),
      },
      {
        path: 'settings',
        loadComponent: () => import('./settings/settings.component').then((m) => m.SettingsComponent),
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
