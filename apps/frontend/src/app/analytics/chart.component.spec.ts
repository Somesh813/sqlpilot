import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DatabaseType, QueryStatus, VisualizationType, type QueryResult } from '@sqlpilot/shared';
import { ChartComponent } from './chart.component';

const result = (rows: Array<Record<string, unknown>>, columns = Object.keys(rows[0] ?? { name: 1, spend: 1 })): QueryResult => ({
  columns: columns.map((name) => ({ name, type: null })),
  rows,
  returnedRows: rows.length,
  totalRows: rows.length,
  executionTimeMs: 1,
  truncated: false,
  status: QueryStatus.SUCCESS,
  historyId: null,
});

describe('ChartComponent', () => {
  let fixture: ComponentFixture<ChartComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const drawn = () => el().querySelector('canvas') !== null;

  function render(r: QueryResult, type: VisualizationType, x: string | null = null, y: string[] = []) {
    const host = document.createElement('div');
    host.style.cssText = 'width:600px;height:320px';
    document.body.appendChild(host);
    fixture = TestBed.createComponent(ChartComponent);
    host.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('result', r);
    fixture.componentRef.setInput('type', type);
    fixture.componentRef.setInput('xField', x);
    fixture.componentRef.setInput('yFields', y);
    fixture.detectChanges();
    return host;
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [ChartComponent] }));

  const data = [
    { name: 'Ada', spend: 500 },
    { name: 'Grace', spend: 900 },
    { name: 'Linus', spend: 100 },
  ];

  for (const type of [VisualizationType.BAR, VisualizationType.LINE, VisualizationType.AREA, VisualizationType.PIE]) {
    it(`draws a real ${type} chart from the rows it is given`, () => {
      const host = render(result(data), type, 'name', ['spend']);
      expect(drawn()).toBe(true);
      expect(el().textContent).not.toContain("couldn't be drawn");
      host.remove();
    });
  }

  it('draws a scatter plot from two numeric columns', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ price: i * 10, sales: i * i }));
    const host = render(result(rows), VisualizationType.SCATTER, 'price', ['sales']);
    expect(drawn()).toBe(true);
    host.remove();
  });

  it('multi-series: several measures on one axis', () => {
    const rows = [{ month: 'Jan', a: 1, b: 2 }, { month: 'Feb', a: 3, b: 1 }];
    const host = render(result(rows), VisualizationType.BAR, 'month', ['a', 'b']);
    expect(drawn()).toBe(true);
    host.remove();
  });

  it('copes with NULLs, decimals, rupee labels and Hindi category names', () => {
    const rows = [
      { label: 'आरव शर्मा', total: 1234.5 },
      { label: '₹ बिक्री', total: null },
      { label: 'Linus', total: 0.1 },
    ];
    const host = render(result(rows), VisualizationType.BAR, 'label', ['total']);
    expect(drawn()).toBe(true);
    host.remove();
  });

  it('does not throw for an empty result (the card never shows a chart for one, but a stray call must be safe)', () => {
    const host = render(result([], ['name', 'spend']), VisualizationType.BAR, 'name', ['spend']);
    expect(() => fixture.detectChanges()).not.toThrow();
    host.remove();
  });

  it('a failure is contained: a message replaces the chart and the page keeps working', () => {
    spyOn(console, 'error');
    const host = render(result(data), VisualizationType.BAR, 'name', ['spend']);
    // force the next render to fail, as a broken ECharts option would
    (fixture.componentInstance as unknown as { buildOption: () => never }).buildOption = () => {
      throw new Error('bad option');
    };
    fixture.componentRef.setInput('type', VisualizationType.LINE);
    fixture.detectChanges();
    return Promise.resolve().then(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance.failed()).toBe(true);
      expect(el().textContent).toContain("couldn't be drawn");
      host.remove();
    });
  });

  it('redraws when the data changes and cleans up on destroy', () => {
    const host = render(result(data), VisualizationType.BAR, 'name', ['spend']);
    fixture.componentRef.setInput('result', result([...data, { name: 'Alan', spend: 300 }]));
    fixture.detectChanges();
    expect(drawn()).toBe(true);
    expect(() => fixture.destroy()).not.toThrow();
    host.remove();
    expect(DatabaseType.SQLITE).toBeDefined(); // (imported only to keep the shared enums exercised in this bundle)
  });
});
