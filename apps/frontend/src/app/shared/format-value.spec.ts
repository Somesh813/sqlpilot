import { formatCell, humanizeHeader } from './format-value';

const numeric = (...cols: string[]) => new Set(cols);

describe('formatCell', () => {
  it('shows NULL as an explicit, distinct value (not blank, not zero)', () => {
    expect(formatCell(null, 'x', numeric())).toEqual({ text: 'NULL', kind: 'null' });
    expect(formatCell(undefined, 'x', numeric())).toEqual({ text: 'NULL', kind: 'null' });
    expect(formatCell('', 'x', numeric()).kind).toBe('text');
    expect(formatCell(0, 'x', numeric('x')).text).toBe('0');
  });

  it('groups digits and limits decimals in measure columns', () => {
    expect(formatCell(1234567.891, 'spend', numeric('spend')).text).toBe((1234567.89).toLocaleString(undefined, { maximumFractionDigits: 2 }));
    expect(formatCell('99999999.99', 'spend', numeric('spend')).kind).toBe('number');
  });

  it('keeps identifiers and calendar years as written', () => {
    expect(formatCell(2026, 'year', numeric('year')).text).toBe('2026');
    expect(formatCell(1234567, 'customer_id', numeric('customer_id')).text).toBe('1234567');
    expect(formatCell(42, 'id', numeric('id')).text).toBe('42');
  });

  it('leaves rupee amounts and Hindi text exactly as they are', () => {
    expect(formatCell('₹ 1,25,000', 'note', numeric())).toEqual({ text: '₹ 1,25,000', kind: 'text' });
    expect(formatCell('आरव शर्मा', 'name', numeric())).toEqual({ text: 'आरव शर्मा', kind: 'text' });
  });

  it('formats booleans, dates, and objects', () => {
    expect(formatCell(true, 'ok', numeric())).toEqual({ text: 'true', kind: 'boolean' });
    expect(formatCell('2026-05-01T10:30:00Z', 'created_at', numeric()).kind).toBe('date');
    expect(formatCell('2026-05-01', 'day', numeric()).kind).toBe('text'); // a plain date string is not shifted by a timezone
    expect(formatCell({ a: 1 }, 'j', numeric()).text).toBe('{"a":1}');
  });

  it('does not treat a numeric-looking string as a number outside a numeric column', () => {
    expect(formatCell('007', 'code', numeric()).text).toBe('007');
  });
});

describe('humanizeHeader', () => {
  it('turns identifiers into readable headings', () => {
    expect(humanizeHeader('total_spending')).toBe('Total Spending');
    expect(humanizeHeader('orderCount')).toBe('Order Count');
    expect(humanizeHeader('created-at')).toBe('Created At');
  });
});
