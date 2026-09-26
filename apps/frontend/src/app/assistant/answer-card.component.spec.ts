import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VisualizationType, type AskResponse } from '@sqlpilot/shared';
import { AnswerCardComponent } from './answer-card.component';
import { askResponse, rowsOf } from '../testing/fixtures';

describe('AnswerCardComponent', () => {
  let fixture: ComponentFixture<AnswerCardComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const has = (sel: string) => el().querySelector(sel) !== null;
  const text = () => el().textContent!.replace(/\s+/g, ' ').trim();

  function render(response: AskResponse) {
    fixture = TestBed.createComponent(AnswerCardComponent);
    fixture.componentRef.setInput('response', response);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [AnswerCardComponent] }));

  it('shows the written answer first, above the data', () => {
    render(askResponse({ explanation: 'There are 8 customers.', rows: rowsOf(2) }));
    expect(el().querySelector('p')!.textContent).toContain('There are 8 customers.');
  });

  it('TABLE: a plain result renders as a table with no chart controls', () => {
    render(askResponse({ rows: rowsOf(3), numericColumns: ['spend'], resultType: 'table' }));
    expect(has('sp-data-table')).toBe(true);
    expect(has('sp-chart')).toBe(false);
    const buttons = Array.from(el().querySelectorAll('button')).map((b) => b.textContent!.trim());
    expect(buttons).not.toContain('Table');
    expect(buttons).not.toContain('Bar');
  });

  it('KPI: a single value is one large number, not a table', () => {
    render(askResponse({ rows: [{ total_customers: 1250 }], resultType: 'single_value', numericColumns: ['total_customers'], availableViews: [VisualizationType.KPI, VisualizationType.TABLE] }));
    expect(has('sp-data-table')).toBe(false);
    expect(text()).toContain('Total Customers');
    expect(text()).toContain((1250).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  });

  it('CHART: a chart-worthy result opens on the recommended chart and offers a Table switch', () => {
    render(
      askResponse({
        rows: rowsOf(5),
        numericColumns: ['spend'],
        resultType: 'categorical',
        availableViews: [VisualizationType.BAR, VisualizationType.PIE, VisualizationType.TABLE],
        visualization: { recommended: true, type: VisualizationType.BAR, xColumn: 'name', yColumns: ['spend'] },
      }),
    );
    expect(has('sp-chart')).toBe(true);
    const labels = Array.from(el().querySelectorAll('button')).map((b) => b.textContent!.trim());
    expect(labels).toEqual(jasmine.arrayContaining(['Table', 'Bar', 'Pie']));

    // switching to Table hides the chart; the data table is always kept underneath
    (Array.from(el().querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Table') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(has('sp-chart')).toBe(false);
    expect(has('sp-data-table')).toBe(true);
  });

  it('a chart is not opened when none was recommended, even if one is available', () => {
    render(askResponse({ rows: rowsOf(4), numericColumns: ['spend'], availableViews: [VisualizationType.BAR, VisualizationType.TABLE], visualization: { recommended: false, type: null, xColumn: null, yColumns: [] } }));
    expect(has('sp-chart')).toBe(false);
    expect(text()).toContain('Bar');
  });

  it('EMPTY: an empty result says so plainly', () => {
    render(askResponse({ rows: [], columns: ['name'], resultType: 'empty', explanation: 'No matching records were found.' }));
    expect(text()).toContain('No matching records were found.');
    expect(text()).toContain('No results found for this query.');
    expect(has('sp-data-table')).toBe(false);
  });

  it('TRUNCATED: a visible warning with the exact numbers', () => {
    render(askResponse({ rows: rowsOf(1000), returnedRows: 1000, totalRows: 1500, truncated: true, numericColumns: ['spend'] }));
    expect(el().querySelector('[data-testid=truncation-notice]')!.textContent).toContain('Showing 1,000 of 1,500 rows.');
  });

  it('TRUNCATED with an unknown total never invents a number', () => {
    render(askResponse({ rows: rowsOf(1000), returnedRows: 1000, totalRows: null, truncated: true }));
    const notice = el().querySelector('[data-testid=truncation-notice]')!.textContent!;
    expect(notice).toContain('Showing the first 1,000 rows. More results are available.');
    expect(notice).not.toMatch(/1,500|of \d/);
  });

  it('no truncation warning at 999 or 1,000 complete rows', () => {
    for (const n of [999, 1000]) {
      render(askResponse({ rows: rowsOf(n), returnedRows: n, totalRows: n, truncated: false }));
      expect(has('[data-testid=truncation-notice]')).toBe(false);
    }
  });

  it('ERROR: a failed request shows the friendly message and no table, chart or SQL', () => {
    render(
      askResponse({
        success: false,
        sql: '',
        rows: [],
        columns: [],
        resultType: 'empty',
        explanation: 'AI service is temporarily busy. Please try again in a moment.',
        error: { stage: 'generation', message: 'AI service is temporarily busy. Please try again in a moment.', code: 'AI_BUSY', technical: null },
      }),
    );
    expect(text()).toContain('AI service is temporarily busy. Please try again in a moment.');
    expect(has('sp-data-table')).toBe(false);
    expect(has('sp-chart')).toBe(false);
    expect(has('details')).toBe(false);
  });

  it('ERROR: technical details appear only when the server sent them (administrators)', () => {
    const failed = { success: false, sql: '', rows: [], columns: [], resultType: 'empty' as const, explanation: 'Sorry.' };
    render(askResponse({ ...failed, error: { stage: 'execution', message: 'Sorry.', code: 'QUERY_FAILED', technical: 'no such column: nme' } }));
    expect(text()).toContain('Technical details');
    expect(text()).toContain('no such column: nme');

    render(askResponse({ ...failed, error: { stage: 'execution', message: 'Sorry.', code: 'QUERY_FAILED', technical: null } }));
    expect(text()).not.toContain('Technical details');
  });

  it('shows warnings and the auto-corrected badge', () => {
    render(askResponse({ rows: rowsOf(2), warnings: ['Dates are in UTC'], autoFixed: true }));
    expect(text()).toContain('Dates are in UTC');
    expect(text()).toContain('auto-corrected');
  });

  it('keeps the SQL behind a toggle and can hand it to the editor', () => {
    render(askResponse({ rows: rowsOf(1), sql: 'SELECT name FROM customers' }));
    const details = el().querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('SELECT name FROM customers');
    let opened = '';
    fixture.componentInstance.openInEditor.subscribe((s: string) => (opened = s));
    (Array.from(details.querySelectorAll('button')).find((b) => /editor/i.test(b.textContent!)) as HTMLButtonElement).click();
    expect(opened).toBe('SELECT name FROM customers');
  });

  it('WIDE result: 40 columns stay inside the card', () => {
    const columns = Array.from({ length: 40 }, (_, i) => `metric_${i}`);
    const row = Object.fromEntries(columns.map((c) => [c, 'value that is rather long']));
    const host = document.createElement('div');
    host.style.width = '480px';
    document.body.appendChild(host);
    fixture = TestBed.createComponent(AnswerCardComponent);
    host.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('response', askResponse({ rows: [row, row], columns }));
    fixture.detectChanges();
    expect(fixture.nativeElement.getBoundingClientRect().width).toBeLessThanOrEqual(480);
    host.remove();
  });

  it('HINDI and rupee values in a result are displayed verbatim', () => {
    render(askResponse({ rows: [{ name: 'आरव शर्मा', note: '₹ 1,25,000' }] }));
    expect(text()).toContain('आरव शर्मा');
    expect(text()).toContain('₹ 1,25,000');
  });
});
