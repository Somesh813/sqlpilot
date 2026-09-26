import {
  describeOmissions,
  isSelectableForLlm,
  maskPii,
  minimizeResultForLlm,
  PII_COLUMN,
  redactCredentials,
  SENSITIVE_COLUMN,
  truncateCell,
} from './llm-privacy';

type Row = Record<string, unknown>;
const view = (columns: string[], rows: Row[], limits = {}) => minimizeResultForLlm(columns, rows, limits);

describe('secret columns never reach the model (F15)', () => {
  it.each([
    'password', 'password_hash', 'passwd', 'pwd', 'user_password', 'secret', 'client_secret', 'api_key', 'apikey', 'access_token',
    'refresh_token', 'auth_token', 'private_key', 'salt', 'otp', 'cvv', 'ssn', 'aadhaar', 'aadhaar_number', 'pan_number', 'card_number',
    'credit_card', 'iban', 'account_number', 'session_id', 'cookie',
  ])('drops %s', (col) => {
    expect(SENSITIVE_COLUMN.test(col)).toBe(true);
    const v = view(['name', col], [{ name: 'Ada', [col]: 'super-secret-value' }]);
    expect(v.columns).toEqual(['name']);
    expect(JSON.stringify(v.rows)).not.toContain('super-secret-value');
    expect(v.omitted.secretColumns).toBe(1);
    expect(isSelectableForLlm(col)).toBe(false);
  });

  it.each(['name', 'city', 'created_at', 'total_spending', 'author', 'span', 'pincode', 'passenger_count', 'category'])(
    'keeps ordinary column %s',
    (col) => {
      expect(SENSITIVE_COLUMN.test(col)).toBe(false);
      expect(isSelectableForLlm(col)).toBe(true);
    },
  );
});

describe('personal contact data is hidden but its place is kept', () => {
  it.each(['email', 'customer_email', 'phone', 'mobile', 'phone_number', 'address', 'street_address', 'dob', 'date_of_birth', 'ip_address'])(
    'masks %s',
    (col) => {
      expect(PII_COLUMN.test(col)).toBe(true);
      const v = view(['name', col], [{ name: 'Ada', [col]: 'ada@example.com' }]);
      expect(v.rows[0][col]).toBe('[hidden]');
      expect(v.omitted.maskedColumns).toEqual([col]);
      expect(JSON.stringify(v.rows)).not.toContain('ada@example.com');
    },
  );

  it('still sends the names needed to word an answer', () => {
    const v = view(['name', 'total'], [{ name: 'Priya Nair', total: 500 }]);
    expect(v.rows).toEqual([{ name: 'Priya Nair', total: 500 }]);
  });

  it('a null in a masked column stays null (so the model does not invent a value)', () => {
    expect(view(['email'], [{ email: null }]).rows[0].email).toBeNull();
  });
});

describe('values are scrubbed whatever their column is called', () => {
  it.each([
    ['an email in a notes column', 'contact ada@example.com today', /ada@example/],
    ['an API key', 'key sk-proj-abcdefghijklmnop1234', /sk-proj/],
    ['a groq key', 'gsk_abcdefghijklmnopqrstuvwx', /gsk_abcdef/],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', /eyJhbGci/],
    ['a connection string', 'postgres://admin:hunter2@db.example.com:5432/app', /hunter2/],
    ['an Indian mobile number', 'call +91 98765 43210', /98765/],
    ['a 10-digit phone', 'reach me on 9876543210', /9876543210/],
    ['an Aadhaar number', 'id 1234 5678 9012', /1234 5678/],
    ['a PAN', 'PAN ABCDE1234F', /ABCDE1234F/],
    ['a card number', 'paid with 4111 1111 1111 1111', /4111 1111/],
    ['password=value text', 'connect with password=hunter2secret', /hunter2secret/],
  ])('scrubs %s', (_label, text, forbidden) => {
    const v = view(['name', 'notes'], [{ name: 'Ada', notes: text }]);
    expect(String(v.rows[0].notes)).not.toMatch(forbidden);
    expect(v.omitted.redactedValues).toBe(1);
  });

  it('does not mangle ordinary numbers, dates or amounts', () => {
    const rows = [{ name: 'A', amount: '12345678901', when: '2026-05-01', ratio: '0.75', code: 'INV-2026-0042', n: 1250000 }];
    const v = view(['name', 'amount', 'when', 'ratio', 'code', 'n'], rows);
    expect(v.rows[0]).toEqual({ name: 'A', amount: '12345678901', when: '2026-05-01', ratio: '0.75', code: 'INV-2026-0042', n: 1250000 });
    expect(v.omitted.redactedValues).toBe(0);
  });

  it('keeps Hindi text and rupee amounts intact', () => {
    const v = view(['name', 'spend'], [{ name: 'आरव शर्मा', spend: '₹1,25,000' }]);
    expect(v.rows[0]).toEqual({ name: 'आरव शर्मा', spend: '₹1,25,000' });
  });
});

describe('only what is needed is sent', () => {
  it('limits rows and reports how many were held back', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ name: `n${i}`, v: i }));
    const v = view(['name', 'v'], rows);
    expect(v.rows).toHaveLength(20);
    expect(v.omitted.rows).toBe(480);
  });

  it('drops identifier columns when something better remains, and keeps them when nothing else does', () => {
    expect(view(['id', 'customer_id', 'name'], [{ id: 1, customer_id: 9, name: 'Ada' }]).columns).toEqual(['name']);
    expect(view(['id'], [{ id: 1 }, { id: 2 }]).columns).toEqual(['id']);
  });

  it('limits columns, preferring labels then measures', () => {
    const cols = ['a', 'b', 'c', 'd', 'label', 'amount'];
    const row = { a: 'x', b: 'x', c: 'x', d: 'x', label: 'Ada', amount: 5 };
    const v = view(cols, [row], { maxColumns: 3 });
    expect(v.columns).toHaveLength(3);
    expect(v.columns).toContain('amount');
    expect(v.omitted.extraColumns).toBe(3);
  });

  it('shortens long cells and hides binary blobs', () => {
    const v = view(['note', 'blob'], [{ note: 'x'.repeat(500), blob: 'QUJD'.repeat(100) }]);
    expect(String(v.rows[0].note).length).toBeLessThanOrEqual(60);
    expect(v.rows[0].blob).toBe('[binary data]');
  });

  it('serialises objects and dates safely', () => {
    expect(truncateCell({ a: 1 }, 60)).toBe('{"a":1}');
    expect(truncateCell(new Date('2026-05-01T00:00:00Z'), 60)).toBe('2026-05-01T00:00:00.000Z');
    expect(truncateCell(undefined, 60)).toBeNull();
  });

  it('handles an empty result', () => {
    const v = view(['a'], []);
    expect(v.rows).toEqual([]);
    expect(v.omitted.rows).toBe(0);
  });

  it('the payload for a large sensitive table stays small and clean', () => {
    const cols = ['id', 'name', 'email', 'phone', 'password_hash', 'address', 'notes', 'created_at'];
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `User ${i}`,
      email: `u${i}@x.com`,
      phone: `98765432${i % 10}0`,
      password_hash: '$2b$12$abcdefghijklmnopqrstuv',
      address: '12 MG Road, Bengaluru',
      notes: 'n'.repeat(300),
      created_at: '2026-01-01',
    }));
    const text = JSON.stringify(view(cols, rows));
    expect(text.length).toBeLessThan(4000);
    expect(text).not.toMatch(/\$2b\$|@x\.com|MG Road|98765432/);
  });

  it('describes what was withheld for the prompt', () => {
    const v = view(['name', 'email', 'password'], Array.from({ length: 30 }, () => ({ name: 'A', email: 'a@b.co', password: 'x' })));
    const note = describeOmissions(v);
    expect(note).toContain('10 more row(s)');
    expect(note).toContain('email');
    expect(note).toContain('Do not guess');
  });
});

describe('redactCredentials / maskPii on free text', () => {
  it('removes credentials and counts them', () => {
    const r = redactCredentials('use sk-abcdefghijklmnopqrstuv and postgres://u:pw@h/db');
    expect(r.text).not.toMatch(/sk-abc|u:pw/);
    expect(r.count).toBe(2);
  });

  it('leaves ordinary SQL untouched', () => {
    const sql = "SELECT name FROM customers WHERE city = 'Mumbai' AND created_at >= '2026-01-01'";
    expect(redactCredentials(sql)).toEqual({ text: sql, count: 0 });
  });

  it('masks personal data in error text', () => {
    expect(maskPii('invalid input syntax for type integer: "ada@example.com"')).not.toContain('ada@example.com');
  });
});
