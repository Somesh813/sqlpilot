import { summarizeRows } from './row-summary';

describe('summarizeRows', () => {
  it.each([
    [0, 0, false, '0 rows'],
    [1, 1, false, '1 row'],
    [999, 999, false, '999 rows'],
    [1000, 1000, false, '1,000 rows'],
  ])('complete result: %i rows -> "%s"', (returned, total, truncated, text) => {
    expect(summarizeRows(returned, total, truncated)).toEqual({ text, incomplete: false });
  });

  it('truncated with a known total says "Showing 1,000 of 1,500 rows."', () => {
    expect(summarizeRows(1000, 1500, true)).toEqual({ text: 'Showing 1,000 of 1,500 rows.', incomplete: true });
  });

  it('truncated with an unknown total says more results are available', () => {
    expect(summarizeRows(1000, null, true)).toEqual({
      text: 'Showing the first 1,000 rows. More results are available.',
      incomplete: true,
    });
  });

  it('the 1,001 boundary is reported as incomplete, 1,000 is not', () => {
    expect(summarizeRows(1000, 1000, false).incomplete).toBe(false);
    expect(summarizeRows(1000, 1001, true).incomplete).toBe(true);
  });

  it('never claims a total smaller than what was returned', () => {
    expect(summarizeRows(1000, 10, true).text).toMatch(/More results are available/);
  });
});
