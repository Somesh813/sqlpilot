import { VisualizationType } from './enums';
import { isNumeric, recommendVisualization, redactSecrets, toCsv } from './utils';

describe('isNumeric', () => {
  it('recognizes numeric values', () => {
    expect(isNumeric(1)).toBe(true);
    expect(isNumeric('2.5')).toBe(true);
    expect(isNumeric(10n)).toBe(true);
  });
  it('rejects non-numeric values', () => {
    expect(isNumeric('abc')).toBe(false);
    expect(isNumeric(null)).toBe(false);
    expect(isNumeric('')).toBe(false);
  });
});

describe('recommendVisualization', () => {
  it('suggests a line chart for time-like categories', () => {
    const rec = recommendVisualization(
      [
        { name: 'month', type: 'text' },
        { name: 'revenue', type: 'numeric' },
      ],
      [
        { month: 'Jan', revenue: 10000 },
        { month: 'Feb', revenue: 13000 },
        { month: 'Mar', revenue: 17000 },
      ],
    );
    expect(rec.type).toBe(VisualizationType.LINE);
    expect(rec.xField).toBe('month');
    expect(rec.yField).toBe('revenue');
  });

  it('suggests a KPI card for a single numeric value', () => {
    const rec = recommendVisualization([{ name: 'total', type: 'numeric' }], [{ total: 42 }]);
    expect(rec.type).toBe(VisualizationType.KPI);
  });

  it('falls back to a table for empty results', () => {
    expect(recommendVisualization([], []).type).toBe(VisualizationType.TABLE);
  });
});

describe('redactSecrets', () => {
  it('masks passwords in connection strings', () => {
    expect(redactSecrets('postgres://user:s3cr3t@host:5432/db')).toBe('postgres://user:***@host:5432/db');
  });
  it('masks key=value secrets', () => {
    expect(redactSecrets('password=hunter2 and token: abc123')).toMatch(/password=\*\*\*/);
  });
});

describe('toCsv', () => {
  it('escapes commas and quotes', () => {
    const csv = toCsv(['a', 'b'], [{ a: 'x,y', b: 'he said "hi"' }]);
    expect(csv).toBe('a,b\n"x,y","he said ""hi"""');
  });
});
