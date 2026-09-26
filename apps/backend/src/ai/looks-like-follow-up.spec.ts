import { looksLikeFollowUp } from './ai-sql.service';

describe('looksLikeFollowUp (fallback when the classifier is unavailable)', () => {
  it.each(['Only for 2026', 'Now show only the top 5', 'and by city?', 'what about Delhi?', 'sort that by date', 'also show email'])(
    'treats "%s" as a follow-up',
    (q) => expect(looksLikeFollowUp(q)).toBe(true),
  );

  it.each([
    'Show sales by month',
    'How many customers are there?',
    'Show customers from Mumbai',
    'Show the top 5 products by sales',
    'Show the distribution of orders by status and also break it down by every single city and month for the whole year',
  ])('treats "%s" as a fresh question', (q) => expect(looksLikeFollowUp(q)).toBe(false));
});
