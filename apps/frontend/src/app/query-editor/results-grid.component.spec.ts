import { ComponentFixture, TestBed } from '@angular/core/testing';
import { QueryStatus, type QueryResult } from '@sqlpilot/shared';
import { ResultsGridComponent } from './results-grid.component';

const result = (rows: Array<Record<string, unknown>>, over: Partial<QueryResult> = {}): QueryResult => ({
  columns: Object.keys(rows[0] ?? { id: 1 }).map((name) => ({ name, type: null })),
  rows,
  returnedRows: rows.length,
  totalRows: rows.length,
  executionTimeMs: 7,
  truncated: false,
  status: QueryStatus.SUCCESS,
  historyId: null,
  ...over,
});

describe('ResultsGridComponent (SQL editor results)', () => {
  let fixture: ComponentFixture<ResultsGridComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = (sel: string) => el().querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const bodyRows = () => el().querySelectorAll('tbody tr').length;

  function render(r: QueryResult) {
    fixture = TestBed.createComponent(ResultsGridComponent);
    fixture.componentRef.setInput('result', r);
    fixture.detectChanges();
  }
  beforeEach(() => TestBed.configureTestingModule({ imports: [ResultsGridComponent] }));

  it('shows the row count and execution time', () => {
    render(result([{ id: 1 }, { id: 2 }]));
    expect(text('[data-testid=row-summary]')).toContain('2 rows');
    expect(text('[data-testid=row-summary]')).toContain('7 ms');
  });

  it('EMPTY: zero rows shows "No rows." and 0 rows', () => {
    render(result([], { columns: [{ name: 'id', type: null }] }));
    expect(el().textContent).toContain('No rows.');
    expect(text('[data-testid=row-summary]')).toContain('0 rows');
  });

  it('TRUNCATED: says exactly how many of how many, using the shared wording', () => {
    render(result(Array.from({ length: 1000 }, (_, i) => ({ id: i })), { returnedRows: 1000, totalRows: 1500, truncated: true }));
    expect(text('[data-testid=row-summary]')).toContain('Showing 1,000 of 1,500 rows.');
  });

  it('TRUNCATED with an unknown total', () => {
    render(result(Array.from({ length: 1000 }, (_, i) => ({ id: i })), { returnedRows: 1000, totalRows: null, truncated: true }));
    expect(text('[data-testid=row-summary]')).toContain('Showing the first 1,000 rows. More results are available.');
  });

  it('has no pager: the server never paginated, so page buttons would be a lie', () => {
    render(result(Array.from({ length: 50 }, (_, i) => ({ id: i })), { totalRows: 5000, truncated: true }));
    const labels = Array.from(el().querySelectorAll('button')).map((b) => b.textContent!.trim());
    expect(labels).not.toContain('Next');
    expect(labels).not.toContain('Prev');
  });

  it('searches within the loaded rows', () => {
    render(result([{ name: 'Ada' }, { name: 'Grace' }, { name: 'Linus' }]));
    fixture.componentInstance.search.set('gra');
    fixture.detectChanges();
    expect(bodyRows()).toBe(1);
  });

  it('sorts numerically, ascending then descending then off', () => {
    render(result([{ n: 10 }, { n: 9 }, { n: 100 }]));
    const first = () => el().querySelector('tbody tr:first-child td')!.textContent!.trim();
    fixture.componentInstance.sortBy('n');
    fixture.detectChanges();
    expect(first()).toBe('9');
    fixture.componentInstance.sortBy('n');
    fixture.detectChanges();
    expect(first()).toBe('100');
    fixture.componentInstance.sortBy('n');
    fixture.detectChanges();
    expect(first()).toBe('10'); // original order
  });

  it('shows NULL as an empty cell and keeps Hindi and rupee text', () => {
    render(result([{ name: 'आरव शर्मा', note: null, amt: '₹ 1,25,000' }]));
    const cells = Array.from(el().querySelectorAll('tbody td')).map((c) => c.textContent!.trim());
    expect(cells).toEqual(['आरव शर्मा', '', '₹ 1,25,000']);
  });
});
