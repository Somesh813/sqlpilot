import { Component, input } from '@angular/core';

@Component({
  selector: 'sp-logo',
  standalone: true,
  template: `
    <span class="inline-flex items-center gap-2 font-semibold text-content-strong">
      <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="url(#sp-g)" />
        <path d="M9 21c2.2 1.6 4.4 2.4 7 2.4 3.6 0 5.5-1.6 5.5-3.8 0-2-1.4-3-4.8-3.8-2.6-.6-3.4-1.1-3.4-2 0-.9.9-1.6 2.6-1.6 1.7 0 3.2.6 4.6 1.6l1.6-2.4C22.6 8.5 20.6 8 18.4 8 15 8 12.8 9.7 12.8 12c0 2.2 1.6 3.1 4.9 3.9 2.5.6 3.3 1 3.3 2 0 1-1 1.7-2.9 1.7-2 0-3.7-.8-5.3-2L9 21Z" fill="white" />
        <defs>
          <linearGradient id="sp-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop stop-color="#6366f1" />
            <stop offset="1" stop-color="#4338ca" />
          </linearGradient>
        </defs>
      </svg>
      @if (showText()) {
        <span>SQLPilot</span>
      }
    </span>
  `,
})
export class LogoComponent {
  readonly size = input(28);
  readonly showText = input(true);
}
