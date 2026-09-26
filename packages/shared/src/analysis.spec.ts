import { VisualizationType as V } from './enums';
import { analyzeResult } from './analysis';

const cols = (rows: Array<Record<string, unknown>>) => Object.keys(rows[0] ?? {});
const analyze = (rows: Array<Record<string, unknown>>, hint?: Parameters<typeof analyzeResult>[2]) =>
  analyzeResult(cols(rows), rows, hint);

describe('analyzeResult', () => {
  it('zero rows → empty, table only, no chart', () => {
    const a = analyzeResult(['id'], []);
    expect(a.resultType).toBe('empty');
    expect(a.availableViews).toEqual([V.TABLE]);
    expect(a.visualization.recommended).toBe(false);
  });

  it('"How many customers?" → single value shown as a KPI, no chart axes', () => {
    const a = analyze([{ total_customers: 1250 }]);
    expect(a.resultType).toBe('single_value');
    expect(a.visualization.type).toBe(V.KPI);
    expect(a.availableViews).toEqual([V.KPI, V.TABLE]);
  });

  it('MySQL DECIMAL strings count as numeric', () => {
    expect(analyze([{ total: '1200.50' }]).resultType).toBe('single_value');
  });

  it('"Sales by month" → line chart on the time column', () => {
    const a = analyze([
      { month: 'January', revenue: 120000 },
      { month: 'February', revenue: 145000 },
      { month: 'March', revenue: 160000 },
    ]);
    expect(a.resultType).toBe('time_series');
    expect(a.visualization).toMatchObject({ recommended: true, type: V.LINE, xColumn: 'month', yColumns: ['revenue'] });
    expect(a.availableViews).toEqual([V.LINE, V.AREA, V.BAR, V.TABLE]);
  });

  it('ISO date column is treated as time', () => {
    const a = analyze([
      { day: '2026-01-01', orders: 4 },
      { day: '2026-01-02', orders: 7 },
      { day: '2026-01-03', orders: 5 },
    ]);
    expect(a.visualization.type).toBe(V.LINE);
  });

  it('"Revenue and profit over time" → multi-series line', () => {
    const a = analyze([
      { month: 'Jan', revenue: 10, profit: 3 },
      { month: 'Feb', revenue: 12, profit: 4 },
      { month: 'Mar', revenue: 15, profit: 6 },
    ]);
    expect(a.resultType).toBe('multi_series');
    expect(a.visualization.yColumns).toEqual(['revenue', 'profit']);
    expect(a.visualization.type).toBe(V.LINE);
  });

  it('"Customers by city" → bar chart, pie offered for few categories', () => {
    const a = analyze([
      { city: 'Mumbai', customers: 40 },
      { city: 'Delhi', customers: 30 },
      { city: 'Pune', customers: 20 },
    ]);
    expect(a.resultType).toBe('categorical');
    expect(a.visualization.type).toBe(V.BAR);
    expect(a.availableViews).toEqual([V.BAR, V.PIE, V.TABLE]);
  });

  it('"Distribution of orders by status" → pie when the model hints pie and it is valid', () => {
    const a = analyze(
      [
        { status: 'shipped', orders: 60 },
        { status: 'pending', orders: 25 },
        { status: 'cancelled', orders: 15 },
      ],
      { type: V.PIE },
    );
    expect(a.resultType).toBe('percentage_distribution');
    expect(a.visualization.type).toBe(V.PIE);
  });

  it('ignores a pie hint when the data cannot be a pie (too many categories)', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ name: `n${i}`, total: i + 1 }));
    const a = analyze(rows, { type: V.PIE });
    expect(a.availableViews).not.toContain(V.PIE);
    expect(a.visualization.type).toBe(V.BAR);
  });

  it('"Customer names and emails" → text only, no chart', () => {
    const a = analyze([
      { name: 'Ada', email: 'ada@x.com' },
      { name: 'Grace', email: 'grace@x.com' },
      { name: 'Linus', email: 'linus@x.com' },
    ]);
    expect(a.availableViews).toEqual([V.TABLE]);
    expect(a.visualization.recommended).toBe(false);
  });

  it('an id column is not treated as a measure', () => {
    const a = analyze([
      { customer_id: 1, name: 'Ada' },
      { customer_id: 2, name: 'Grace' },
      { customer_id: 3, name: 'Linus' },
    ]);
    expect(a.availableViews).toEqual([V.TABLE]);
  });

  it('too many categories to read → table only', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ name: `customer ${i}`, spend: i }));
    expect(analyze(rows).availableViews).toEqual([V.TABLE]);
  });

  it('two numeric columns with many observations → scatter', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ height: 150 + i, weight: 50 + i * 2 }));
    const a = analyze(rows);
    expect(a.resultType).toBe('correlation');
    expect(a.visualization.type).toBe(V.SCATTER);
  });

  it('two rows are charted only on request, not recommended', () => {
    const a = analyze([
      { store: 'A', sales: 10 },
      { store: 'B', sales: 20 },
    ]);
    expect(a.visualization.recommended).toBe(false);
    expect(a.availableViews).toContain(V.BAR);
  });

  it('a single row that is not all numbers stays a table', () => {
    expect(analyze([{ name: 'Ada', spend: 10 }]).resultType).toBe('table');
  });
});
