import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DataTableComponent } from './data-table.component';
import { rowsOf } from '../../testing/fixtures';

describe('DataTableComponent', () => {
  let fixture: ComponentFixture<DataTableComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = (sel: string) => el().querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const rowCount = () => el().querySelectorAll('tbody tr').length;

  function render(inputs: {
    columns: string[];
    rows: Array<Record<string, unknown>>;
    numericColumns?: string[];
    totalRows?: number | null;
    truncated?: boolean;
  }) {
    fixture = TestBed.createComponent(DataTableComponent);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [DataTableComponent] }));

  it('TABLE: renders readable headers and one row per record', () => {
    render({
      columns: ['customer_name', 'total_spending'],
      rows: [{ customer_name: 'Ada', total_spending: 500 }, { customer_name: 'Grace', total_spending: 900 }],
      numericColumns: ['total_spending'],
    });
    const headers = Array.from(el().querySelectorAll('th')).map((h) => h.textContent!.trim());
    expect(headers).toEqual(['Customer Name', 'Total Spending']);
    expect(rowCount()).toBe(2);
    expect(text('tbody tr:first-child')).toContain('Ada');
  });

  it('EMPTY: zero rows shows an accurate count, not a blank box', () => {
    render({ columns: ['name'], rows: [] });
    expect(rowCount()).toBe(0);
    expect(text('[data-testid=row-summary]')).toBe('0 rows');
  });

  it('a single row is singular', () => {
    render({ columns: ['name'], rows: [{ name: 'Ada' }] });
    expect(text('[data-testid=row-summary]')).toBe('1 row');
  });

  it('TRUNCATED with a known total says exactly how many exist', () => {
    render({ columns: ['name', 'spend'], rows: rowsOf(1000), totalRows: 1500, truncated: true });
    expect(text('[data-testid=row-summary]')).toContain('Showing 1,000 of 1,500 rows.');
  });

  it('TRUNCATED with an unknown total says more results are available', () => {
    render({ columns: ['name', 'spend'], rows: rowsOf(1000), totalRows: null, truncated: true });
    expect(text('[data-testid=row-summary]')).toContain('Showing the first 1,000 rows. More results are available.');
  });

  it('boundaries: 999 and 1,000 complete rows carry no truncation warning', () => {
    for (const n of [999, 1000]) {
      render({ columns: ['name', 'spend'], rows: rowsOf(n), totalRows: n, truncated: false });
      expect(text('[data-testid=row-summary]')).not.toContain('Showing');
      expect(text('[data-testid=row-summary]')).toContain(`${n.toLocaleString('en-US')} rows`);
    }
  });

  it('draws at most 200 rows in the page but says so, and keeps every row for the CSV', () => {
    render({ columns: ['name', 'spend'], rows: rowsOf(1000), totalRows: 1000, truncated: false });
    expect(rowCount()).toBe(200);
    expect(text('[data-testid=display-cap]')).toContain('first 200 rows');
    expect(text('[data-testid=display-cap]')).toContain('all 1,000');
  });

  it('WIDE TABLE: 60 columns scroll inside the table box and never widen the page', () => {
    const columns = Array.from({ length: 60 }, (_, i) => `column_number_${i}`);
    const row = Object.fromEntries(columns.map((c) => [c, 'a fairly long cell value here']));
    const host = document.createElement('div');
    host.style.width = '400px';
    document.body.appendChild(host);
    fixture = TestBed.createComponent(DataTableComponent);
    host.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('columns', columns);
    fixture.componentRef.setInput('rows', [row]);
    fixture.detectChanges();

    const box = el().querySelector('.sp-scroll') as HTMLElement;
    expect(getComputedStyle(box).overflowX).toBe('auto');
    expect(fixture.nativeElement.getBoundingClientRect().width).toBeLessThanOrEqual(400);
    expect(box.scrollWidth).toBeGreaterThan(box.clientWidth); // the overflow is inside the box
    host.remove();
  });

  it('renders NULL distinctly, right-aligns numbers, and keeps rupee and Hindi text intact', () => {
    render({
      columns: ['name', 'note', 'spend'],
      rows: [
        { name: 'आरव शर्मा', note: null, spend: 1234567.5 },
        { name: 'Linus', note: '₹ 1,25,000', spend: 10 },
      ],
      numericColumns: ['spend'],
    });
    const cells = Array.from(el().querySelectorAll('tbody tr:first-child td'));
    expect(cells[0].textContent!.trim()).toBe('आरव शर्मा');
    expect(cells[1].textContent!.trim()).toBe('NULL');
    expect(cells[1].classList.contains('italic')).toBe(true);
    expect(cells[2].classList.contains('text-right')).toBe(true);
    expect(el().querySelectorAll('tbody tr:nth-child(2) td')[1].textContent!.trim()).toBe('₹ 1,25,000');
  });

  it('downloads a CSV with every loaded row, beyond the 200 drawn', async () => {
    render({ columns: ['name', 'spend'], rows: rowsOf(300), totalRows: 300 });
    let blob: Blob | null = null;
    spyOn(URL, 'createObjectURL').and.callFake((b: Blob | MediaSource) => {
      blob = b as Blob;
      return 'blob:x';
    });
    spyOn(URL, 'revokeObjectURL');
    const click = spyOn(HTMLAnchorElement.prototype, 'click').and.stub();
    (Array.from(el().querySelectorAll('button')).find((b) => /csv/i.test(b.textContent!)) as HTMLButtonElement).click();
    expect(click).toHaveBeenCalled();
    const csv = await (blob as unknown as Blob).text();
    expect(csv.trim().split('\n').length).toBe(301); // header + 300 rows
  });
});
