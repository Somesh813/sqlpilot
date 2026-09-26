# Acceptance checklist

Result of the audit-fix programme (phases 1 to 10). Each row names the change and where to find
the proof. "Verified" means an automated test or a live run exercised it and passed; anything
short of that is listed under [Open items](#open-items).

Re-run everything with:

```bash
npm run build && npm run test:all
```

## Gates

| Gate | Result |
| --- | --- |
| Build (packages, backend, Angular) | passes |
| Type-check (all packages, backend, frontend app and specs) | passes, 0 errors |
| Unit and integration tests | shared 164, sql-parser 212, database 146, backend 117: all pass |
| Backend end-to-end tests | 206 pass |
| Frontend component tests (headless Chrome) | 64 pass |
| Lint | not configured (see open items) |
| PostgreSQL tests exist | yes: `packages/database/src/postgres-driver.spec.ts`, real PostgreSQL via `embedded-postgres` |
| MySQL tests exist | yes: `packages/database/src/mysql-driver.spec.ts`, real MySQL 8.0.43 via `mysql-memory-server` |
| SQLite tests exist | yes: `packages/database/src/sqlite-driver.spec.ts` |
| Frontend result-rendering tests exist | yes: `data-table`, `answer-card`, `results-grid`, `workspace` specs (table, KPI, empty, error, loading, truncated, wide) |
| Frontend chart tests exist | yes: `chart.component.spec.ts` (bar, line, area, pie, scatter, multi-series, NULL/Hindi labels, failure isolation) |
| The ten manual questions | passed in the real UI, each checked against direct SQL (phase 9) |

## Findings

| # | Finding | Status | Proof |
| --- | --- | --- | --- |
| F1 | Real read-only enforcement | Verified | PostgreSQL `BEGIN READ ONLY`, SQLite `query_only`, MySQL read-only transaction. DROP, DELETE, UPDATE, INSERT, ALTER, TRUNCATE, SELECT INTO, FOR UPDATE, COPY PROGRAM and CREATE are refused by each driver test. MySQL caveat below. |
| F2 | AST validation instead of keywords | Verified | `validator.spec.ts` (162 cases): single SELECT or WITH-over-SELECT only, nested DML, comment-hidden SQL, dangerous functions on all three engines, fail-closed on parse errors. |
| F3 | Heavy SQLite query cannot freeze the API | Verified | `sqlite-driver.spec.ts`: timeout on schedule, cancellation, concurrent request during a heavy query, no orphan process. |
| F4 | Path and host restrictions | Verified | `connection-policy.spec.ts` (29) and the connection e2e: one uniform error, symlinks and `..` refused, private and metadata hosts refused. |
| F5 | Reverse-proxy handling | Verified | `proxy.e2e-spec.ts`: per-client login limit behind nginx, forged `X-Forwarded-For` cannot dodge or frame. AI limit uses the same guard (no separate test). |
| F6 | Reset tokens never logged or returned | Verified | `password-reset.e2e-spec.ts`: identical answers for known and unknown emails, token only in the mailed link, absent from every log line, single use, dev outbox refused in production. |
| F7 | No hardcoded credentials, no public database | Verified by tests reading the files; not run in Docker | `deployment.spec.ts`, `env.validation.spec.ts`. Compose was never started (no Docker daemon here). |
| F8 | Schema selection with joins | Verified | `schema-select.spec.ts` and the multi-hop scenario over five tables. |
| F9 | Answers grounded in data | Verified | `answer-facts.spec.ts` and the contradictory-answer e2e cases (count, "no results", wrong superlative). |
| F10 | No silent truncation | Verified | Driver tests at 0, 1, 999, 1,000, 1,001 and 1,500 rows on all three engines, HTTP suite, and frontend specs for the wording. |
| F11 | Safe rate-limit message | Verified | `safe-errors.spec.ts`, ask e2e: exact wording, no organisation id or provider text. |
| F12 | Safe database-unavailable message | Verified | `errors.spec.ts`, ask e2e: exact wording, no path or address, no pointless repair. |
| F13 | Row cap cannot be bypassed | Verified | Huge and nested LIMIT cases through the full HTTP stack and all drivers. |
| F14 | Persistent pools, fewer sequential calls | Verified for pools; calls only partly reduced | `registry.spec.ts`, PostgreSQL and MySQL pool tests (about 1 ms against 48 ms per query on PostgreSQL). The follow-up check and schema load now run together; the model calls themselves are unchanged. |
| F15 | Minimal data to the AI provider | Verified | `llm-privacy.spec.ts` (71), `privacy-guard.provider.spec.ts`, ask e2e assertions on the prompts sent. |
| F16 | Validate SQL against the schema | Verified | `schema-check.spec.ts` (51) and the F16 e2e block: two repairs at most, loop and no-progress guards. |
| F17 | Test coverage | Verified | The suites above. |

## Open items

These are known and not hidden.

1. **The default model (`gpt-oss-120b`) was not verified live in the last phases.** Groq's daily
   token limit was exhausted by testing. The final live run got 2 of 11 questions through before
   the limit returned "temporarily busy" (which shows the safe message working). The ten questions
   passed in the real UI with `gpt-oss-20b` in phase 9. Re-run `node regress.js`-style checks on
   120b once the limit resets.
2. **MySQL read-only is weaker than the other engines.** A MySQL read-only transaction refuses
   DML but not DDL (verified). On MySQL the AST validator and the driver's SELECT-only check carry
   that protection. Use an account with only SELECT.
3. **One unexplained end-to-end failure.** In one full run, one test in `ask.e2e-spec.ts` failed and
   I did not capture which. It did not recur in the eight full runs and many single-file runs
   that followed. Treat it as a possible timing flake until it is caught.
4. **Docker and nginx are untested in a container.** Checked only by tests that read the files.
5. **Lint is not configured** (`ng lint` has no target and there is no ESLint config), so style is
   enforced by review only.
6. **Database TLS certificates are not verified.** The PostgreSQL and MySQL drivers connect with
   `rejectUnauthorized: false` when SSL is on. This was found during phase 5 and not changed.
7. **Backend unit coverage is 37%** (statements). The end-to-end suite covers most of the rest but
   cannot be measured with the current Jest configuration.
8. **Answer checking has limits.** It checks numbers, "no results", single values, totals of partial
   results, and single-item superlatives. It does not check that a name is paired with the right
   value in a list, or that a description such as "growing" is true.
9. **Follow-ups on very large schemas** widen table selection with the previous question but rely
   on the model to reuse the earlier SQL.
10. **Model quality is not covered by automated tests.** They script the model, so they prove the
    code around it, not its SQL.

## What changed, in order

| Phase | Commit | Summary |
| --- | --- | --- |
| 1 | `3f32e1b` | AST validation, real read-only transactions, exact row caps |
| 2 | `751adbf` | Foreign-key schema selection, grounded answers, truncation wording |
| 3 | `e5da9b2` | Killable SQLite queries, connection policy, proxy IPs, reset mail, deployment hardening |
| 4 | `3b1d452` | Safe user-facing errors |
| 5 | `c1465f3` | Persistent pools, concurrent independent steps |
| 6 | `4d63c40` | Data minimisation for the AI provider |
| 7 | `364b602` | Schema validation and bounded repair |
| 8 | `a4ae118` | MySQL and frontend suites; MySQL write bug; superlative check |
| 9 | `b12bf2c` | Manual UI verification; question-box fix; invalid-JSON retry |
| 10 | this document | Acceptance |
