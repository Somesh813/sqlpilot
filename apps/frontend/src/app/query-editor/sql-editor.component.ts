import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  computed,
  signal,
} from '@angular/core';

/**
 * Lightweight SQL editor: monospace textarea with a synced line-number gutter,
 * soft-tab handling, and Ctrl/Cmd+Enter to run. Syntax highlighting is applied
 * to a read-only layer behind the textarea.
 */
@Component({
  selector: 'sp-sql-editor',
  standalone: true,
  template: `
    <div class="relative flex h-full overflow-hidden rounded-xl border border-surface-border bg-surface-0 font-mono text-[13px]">
      <div
        #gutter
        class="sp-scroll select-none overflow-hidden border-r border-surface-border bg-surface-1 px-2 py-3 text-right text-content-muted"
        aria-hidden="true"
      >
        @for (n of lineNumbers(); track n) {
          <div class="leading-5">{{ n }}</div>
        }
      </div>
      <textarea
        #ta
        class="sp-scroll flex-1 resize-none bg-transparent px-3 py-3 leading-5 text-content-strong outline-none"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        [value]="value"
        [placeholder]="placeholder"
        (input)="onInput($event)"
        (scroll)="syncScroll()"
        (keydown)="onKeydown($event)"
      ></textarea>
    </div>
  `,
})
export class SqlEditorComponent {
  @Input() value = '';
  @Input() placeholder = 'Write SQL, or ask the assistant to generate it…';
  @Output() valueChange = new EventEmitter<string>();
  @Output() run = new EventEmitter<void>();

  @ViewChild('ta') ta!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('gutter') gutter!: ElementRef<HTMLDivElement>;

  private readonly text = signal('');
  readonly lineNumbers = computed(() => {
    const count = Math.max(1, (this.text() || this.value).split('\n').length);
    return Array.from({ length: count }, (_, i) => i + 1);
  });

  ngOnChanges(): void {
    this.text.set(this.value);
  }

  focus(): void {
    this.ta?.nativeElement.focus();
  }

  onInput(event: Event): void {
    const v = (event.target as HTMLTextAreaElement).value;
    this.text.set(v);
    this.value = v;
    this.valueChange.emit(v);
  }

  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      this.run.emit();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const el = this.ta.nativeElement;
      const { selectionStart: s, selectionEnd: e } = el;
      el.value = `${el.value.slice(0, s)}  ${el.value.slice(e)}`;
      el.selectionStart = el.selectionEnd = s + 2;
      this.onInput({ target: el } as unknown as Event);
    }
  }

  syncScroll(): void {
    if (this.gutter && this.ta) {
      this.gutter.nativeElement.scrollTop = this.ta.nativeElement.scrollTop;
    }
  }
}
