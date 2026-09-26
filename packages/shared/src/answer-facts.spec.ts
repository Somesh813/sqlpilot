import { buildResultFacts, deterministicAnswer, extractNumericClaims, superlativeMismatch, verifyAnswer } from './answer-facts';

type Row = Record<string, unknown>;
const facts = (
  columns: string[],
  rows: Row[],
  extra: { totalRows?: number | null; truncated?: boolean; returnedRows?: number } = {},
) => buildResultFacts({ columns, rows, ...extra });
const ok = (answer: string, f: ReturnType<typeof facts>, q = '') => verifyAnswer(answer, f, q);

describe('answers must match the data', () => {
  const count3 = facts(['total_customers'], [{ total_customers: 3 }]);

  it('COUNT = 3 can never become "2 customers"', () => {
    expect(ok('There are 2 customers.', count3).ok).toBe(false);
    expect(ok('There are two customers.', count3).ok).toBe(false);
    expect(ok('There are 3 customers.', count3).ok).toBe(true);
    expect(ok('There are three customers.', count3).ok).toBe(true);
  });

  it('a single value must be stated, not just avoided', () => {
    const r = ok('There are some customers.', count3);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('single_value_not_stated');
  });

  it('"no matching records" is rejected when rows exist (the live F9 failure)', () => {
    const f = facts(['name', 'city'], [{ name: 'Sneha', city: 'Mumbai' }]);
    const r = ok('No matching records were found.', f);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('claims_no_results_but_rows_exist');
  });

  it('an empty result cannot carry invented numbers', () => {
    const f = facts(['name'], []);
    expect(ok('No matching records were found.', f).ok).toBe(true);
    expect(ok('There are 4 customers in Mumbai.', f).ok).toBe(false);
  });

  it('rejects a number that is not in the data', () => {
    const f = facts(['name', 'spend'], [{ name: 'Ada', spend: 360000 }, { name: 'Grace', spend: 288000 }]);
    expect(ok('Ada spent 360,000 and Grace spent 288,000.', f).ok).toBe(true);
    const bad = ok('Ada spent 350,000.', f);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toContain('unsupported_number:350,000');
  });

  it('accepts figures derived from the data: sums, differences, percentages, extremes', () => {
    const f = facts(['month', 'orders'], [{ month: 'This month', orders: 5 }, { month: 'Last month', orders: 6 }]);
    expect(ok('This month had 5 orders, 1 fewer than last month, which had 6.', f).ok).toBe(true);
    expect(ok('Together that is 11 orders.', f).ok).toBe(true);
    expect(ok('Orders fell by about 17%.', f).ok).toBe(true);
    expect(ok('Orders fell by 40%.', f).ok).toBe(false);
  });

  it('ID columns cannot vouch for a count (customer_id 3 is not "3 customers")', () => {
    const f = facts(['customer_id', 'name'], [{ customer_id: 3, name: 'Ada' }]);
    expect(ok('There are 3 customers.', f).ok).toBe(false);
    expect(ok('Found 1 customer: Ada.', f).ok).toBe(true);
  });

  it('rounding: displayed precision is honoured, wrong magnitudes are not', () => {
    const f = facts(['revenue'], [{ revenue: 1234.5 }]);
    expect(ok('Revenue is 1,234.50.', f).ok).toBe(true);
    expect(ok('Revenue is 1,235.', f).ok).toBe(true);
    expect(ok('Revenue is 1,300.', f).ok).toBe(false);
  });

  it('understands lakh / crore / k / million suffixes', () => {
    const f = facts(['revenue'], [{ revenue: 152000 }]);
    expect(ok('Revenue is about 1.5 lakh.', f).ok).toBe(true);
    expect(ok('Revenue is about 152k.', f).ok).toBe(true);
    expect(ok('Revenue is about 2 lakh.', f).ok).toBe(false);
    expect(ok('Revenue is about 3 million.', f).ok).toBe(false);
  });

  it('handles rupee amounts, Indian digit grouping and Hindi labels', () => {
    const f = facts(['name', 'spend'], [{ name: 'आरव शर्मा', spend: 125000 }, { name: 'Priya Nair', spend: 99000 }]);
    expect(ok('आरव शर्मा spent ₹1,25,000, the most.', f).ok).toBe(true);
    expect(ok('आरव शर्मा spent ₹1,52,000.', f).ok).toBe(false);
  });

  it('numbers inside dates are quotable, and numbers from the question are allowed', () => {
    const f = facts(['month', 'orders'], [{ month: '2026-05', orders: 12 }]);
    expect(ok('In 2026 there were 12 orders.', f).ok).toBe(true);
    expect(ok('Here are the top 5.', facts(['name'], [{ name: 'a' }, { name: 'b' }]), 'show the top 5').ok).toBe(true);
    expect(ok('Here are the top 5.', facts(['name'], [{ name: 'a' }, { name: 'b' }]), 'show them').ok).toBe(false);
  });

  it('ignores ordinals and stray words like "no one"', () => {
    const f = facts(['name', 'spend'], [{ name: 'Ada', spend: 10 }, { name: 'Bob', spend: 5 }]);
    expect(ok('Ada is 1st with 10, and Bob is 2nd with 5.', f).ok).toBe(true);
    expect(ok('Ada spent 10; no one spent more.', f).ok).toBe(true);
  });
});

describe('truncation is never presented as a total (F10)', () => {
  const partial = (total: number | null) =>
    facts(
      ['id_no', 'amount'],
      Array.from({ length: 1000 }, (_, i) => ({ id_no: i, amount: 10 })),
      { truncated: true, totalRows: total, returnedRows: 1000 },
    );

  it('rejects "in total" for a partial result with unknown total', () => {
    expect(ok('There are 1,000 rows in total.', partial(null)).ok).toBe(false);
    expect(ok('Here are the first 1,000 rows.', partial(null)).ok).toBe(true);
  });

  it('allows the real total when it is known, and rejects a wrong one', () => {
    expect(ok('Showing 1,000 of 1,500 rows.', partial(1500)).ok).toBe(true);
    expect(ok('There are 1,600 rows.', partial(1500)).ok).toBe(false);
  });

  it('does not accept a sum of a partial result as if it were the total', () => {
    expect(ok('The amounts add up to 10,000.', partial(1500)).ok).toBe(false);
    const complete = facts(['amount'], Array.from({ length: 1000 }, () => ({ amount: 10 })));
    expect(ok('The amounts add up to 10,000.', complete).ok).toBe(true);
  });
});

describe('deterministicAnswer', () => {
  it('states an empty result honestly', () => {
    expect(deterministicAnswer(facts(['a'], []))).toBe('No matching records were found.');
  });

  it('states a single value exactly', () => {
    expect(deterministicAnswer(facts(['total_customers'], [{ total_customers: 10 }]))).toBe('Total customers: 10.');
  });

  it('describes a list from the data and always verifies against itself', () => {
    const f = facts(['name', 'spend'], [{ name: 'Ada', spend: 360000 }, { name: 'Bob', spend: 5000 }]);
    const text = deterministicAnswer(f);
    expect(text).toContain('Ada (360,000)');
    expect(text).toContain('Bob (5,000)');
    expect(verifyAnswer(text, f).ok).toBe(true);
  });

  it('says so when the result is cut off', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
    expect(deterministicAnswer(facts(['n'], rows, { truncated: true, totalRows: 1500, returnedRows: 1000 }))).toBe(
      'Showing 1,000 of 1,500 rows.',
    );
    expect(deterministicAnswer(facts(['n'], rows, { truncated: true, totalRows: null, returnedRows: 1000 }))).toBe(
      'Showing the first 1,000 rows. More results are available.',
    );
  });

  it.each([[[{ a: 1 }]], [[{ a: 1 }, { a: 2 }, { a: 3 }]]])('is self-consistent for %j', (rows) => {
    const f = facts(['a'], rows as Row[]);
    expect(verifyAnswer(deterministicAnswer(f), f).ok).toBe(true);
  });
});

describe('extractNumericClaims', () => {
  it('finds digits, words and suffixes', () => {
    const claims = extractNumericClaims('Three customers spent 1,25,000 and 2.5 lakh, the 1st being 40%.').map((c) => c.value);
    expect(claims).toEqual(expect.arrayContaining([3, 125000, 250000, 40]));
    expect(claims).not.toContain(1);
  });
});

describe('superlative claims must name the row that really holds the extreme', () => {
  const products = facts(['name', 'price'], [
    { name: 'Phone', price: 30000 },
    { name: 'Laptop', price: 60000 },
    { name: 'Novel', price: 500 },
  ]);

  it('accepts the right item for highest and lowest', () => {
    expect(ok('The most expensive product is Laptop at 60,000.', products).ok).toBe(true);
    expect(ok('The cheapest item is the Novel, at 500.', products).ok).toBe(true);
  });

  it('rejects a real item paired with the wrong extreme (both numbers exist in the data)', () => {
    const r = ok('The most expensive product is Phone at 30,000.', products);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('superlative_mismatch:Phone');
    expect(ok('The cheapest product is Laptop.', products).ok).toBe(false);
  });

  it('skips sentences that name several items or no item, and does not police plain lists', () => {
    expect(ok('The top 2 are Laptop and Phone.', products, 'show the top 2').ok).toBe(true);
    expect(ok('Prices range from 500 to 60,000.', products).ok).toBe(true);
    expect(ok('Laptop costs 60,000, Phone 30,000 and Novel 500.', products).ok).toBe(true);
  });

  it('accepts ties, and a claim that holds for any measure column', () => {
    const tie = facts(['name', 'score'], [{ name: 'A', score: 9 }, { name: 'B', score: 9 }, { name: 'C', score: 1 }]);
    expect(ok('The highest score belongs to B.', tie).ok).toBe(true);
    const multi = facts(['name', 'revenue', 'orders'], [{ name: 'A', revenue: 100, orders: 1 }, { name: 'B', revenue: 50, orders: 9 }]);
    expect(ok('B has the most orders.', multi).ok).toBe(true);
    expect(ok('A has the highest revenue.', multi).ok).toBe(true);
  });

  it('does not judge a partial result (the real extreme may not be in the sample)', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `Item ${i}`, v: i }));
    const partial = facts(['name', 'v'], rows, { truncated: true, totalRows: null, returnedRows: 1000 });
    expect(superlativeMismatch('The highest is Item 3.', partial)).toBeNull();
  });

  it('a longer name containing a shorter one is one item, not two', () => {
    const f = facts(['name', 'price'], [{ name: 'Phone', price: 100 }, { name: 'Phone Pro', price: 900 }]);
    expect(ok('The most expensive is Phone Pro.', f).ok).toBe(true);
  });
});
