import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from './shared/ui/toast-container.component';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'sp-root',
  standalone: true,
  imports: [RouterOutlet, ToastContainerComponent],
  template: `
    <router-outlet />
    <sp-toast-container />
  `,
})
export class AppComponent {
  // Instantiating the theme service applies the persisted theme app-wide.
  private readonly theme = inject(ThemeService);
}
