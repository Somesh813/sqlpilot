import { parseDuration } from './tokens.service';

describe('parseDuration', () => {
  it.each([
    ['15m', 900_000],
    ['7d', 604_800_000],
    ['1h', 3_600_000],
    ['500ms', 500],
    ['30s', 30_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('falls back to a raw number', () => {
    expect(parseDuration('1000')).toBe(1000);
  });
});
