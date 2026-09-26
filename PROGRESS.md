# SQLPilot — build progress

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Project setup + architecture (monorepo, shared packages, config, common infra, health, Docker) | ✅ Done |
| 2 | Authentication (register, login, refresh rotation, forgot/reset, change password, roles, guards; frontend auth flow + shell + dashboard skeleton) | ✅ Done |
| 3 | Database connection manager (CRUD, encrypted credentials, test connection, status) | ✅ Done |
| 4 | Schema discovery (introspection endpoints, explorer sidebar) | ✅ Done |
| 5 | SQL editor + query execution (validate → policy → confirm → execute, results grid) | ✅ Done |
| 6 | AI SQL generation (schema context selection, structured output, conversations) | ✅ Done |
| 7 | AI explanation + optimization + fix-with-AI | ✅ Done |
| 8 | Query history + saved queries + reusable prompts | ✅ Done |
| 9 | Charts + analytics dashboard | ✅ Done |
| 10 | Security hardening pass (rate limits, audit coverage, red-team the parser) | ✅ Done |
| 11 | Testing (unit + integration across modules) | ✅ Done |
| 12 | Docker + production configuration polish | ⏳ In progress |

## Phase 1 — delivered

- npm-workspaces monorepo, `tsconfig.base.json` with path aliases
- `@sqlpilot/shared` — enums, model interfaces, API contracts, constants, pure helpers
- `@sqlpilot/sql-parser` — AST parsing (`node-sql-parser`), statement classification,
  security policy, literal/comment stripping, LIMIT injection; **19 unit tests**
- `@sqlpilot/ai` — `AiProvider` interface, `OpenAiProvider` (JSON-schema structured output),
  prompt templates, Zod output schemas, schema-context renderer
- `@sqlpilot/database` — Postgres / MySQL / SQLite drivers with schema introspection and
  guarded query execution, driver factory
- Backend bootstrap: config + env validation, pino logging, request-id middleware,
  global exception filter, throttler, `EncryptionService` (AES-256-GCM), `/health`
- Docker: multi-stage backend + frontend images, `docker-compose.yml`, mongo init

## Phase 2 — delivered

- `User` + `RefreshToken` Mongo schemas; `UsersService`
- `AuthService`: bcrypt hashing, token issue/rotate, reuse detection, uniform login errors,
  forgot/reset password, change password (revokes sessions)
- `AuthController` with all routes; `JwtStrategy`, `JwtAuthGuard` (global), `RolesGuard`
- `AuditService` + `AuditLog` schema; login / login-failed / password-changed events
- Tests: `auth.service.spec` (mocked), `tokens.service.spec`, `encryption.service.spec`,
  `auth.e2e-spec` (register → login → refresh → profile, reuse rejection, dup registration,
  weak password, unauthenticated profile), `app.e2e-spec` (full AppModule boots; liveness;
  global guard; DTO whitelist rejects extra fields)
- Frontend: signal-based `AuthService`, token storage, auth + error interceptors,
  route guards, auth layout, app shell (responsive sidebar + topbar), login / register,
  dashboard skeleton with "Ask SQLPilot" box and stat cards, settings (theme + change password),
  dark/light theme with no-flash boot script

## Verification status (Phase 1–2)

All green as of the last run:

| Check | Command | Result |
| --- | --- | --- |
| Full build | `npm run build` | ✅ packages → backend (`dist/main.js`) → frontend |
| Backend type-check | `npm run lint --workspace @sqlpilot/backend` | ✅ no errors |
| `@sqlpilot/shared` tests | `npm test --workspace @sqlpilot/shared` | ✅ 8/8 |
| `@sqlpilot/sql-parser` tests | `npm test --workspace @sqlpilot/sql-parser` | ✅ 19/19 |
| Backend unit tests | `npm run test:backend` | ✅ 18/18 |
| Backend e2e (in-memory Mongo) | `npm run test:e2e` | ✅ 15/15 (auth + AppModule bootstrap + connections) |
| Frontend production build | `npm run build --workspace @sqlpilot/frontend` | ✅ |

**60 tests passing.**

## Phase 3 — delivered

- `DatabaseConnection` schema; credentials stored as one AES-256-GCM blob,
  `select: false` so they never load into a normal query
- `DatabaseConnectionsService`: create (tests before persisting), update
  (re-encrypts only when credentials change, blank password = unchanged),
  delete, ad-hoc test, re-test stored + persist status, `resolveDriverConfig`
  for later phases; per-user scoping on every query
- `DatabaseConnectionsController`: `GET/POST /databases`, `POST /databases/test`,
  `GET/PATCH/DELETE /databases/:id`, `POST /databases/:id/test`
- Audit events for create/update/delete/test
- Frontend: `ConnectionsService` (signal store), `connections.component`
  (card grid, status badges, empty state), `connection-form` modal with
  engine-conditional fields, live "Test connection", inline errors
- 7 e2e tests: auth required, ad-hoc test (ok + failure), create hides
  credentials (SQLite + Postgres), missing-host rejection, list/retest/delete,
  cross-user isolation

## Phases 4–9 — delivered

**Schema (4):** `SchemaSnapshot` cache in Mongo; `GET/POST /databases/:id/schema[/refresh]`;
`SchemaService.buildContext()` keyword-scores tables/columns against the question, pulls in
directly related tables via FKs, caps at `AI_MAX_SCHEMA_TABLES`, and reports the rest as
`omittedTables` — this is what keeps large schemas out of the AI prompt. Frontend schema
explorer (expandable tables, PK/FK badges, "Query"/"Ask AI" per table).

**SQL editor + execution (5):** Lightweight dependency-free `sp-sql-editor` (line-number
gutter, Ctrl/Cmd+Enter, soft tabs) instead of Monaco — keeps the bundle small and the build
free of worker/CSP issues; a basic SQL pretty-printer (`formatSql`) covers Format. Every
execution goes through `QueryExecutionService`: `validateSql` → policy → `confirmed: true`
required → driver execution with timeout/row cap/pagination → `QueryHistory` record → audit.
Blocked queries and DB errors are both recorded to history. `sp-results-grid`: client sort/
filter, cell copy, CSV/JSON export, server pagination.

**AI generation (6) + explain/optimize/fix (7):** `AiModule` binds an `AI_PROVIDER` — the real
`OpenAiProvider` when `OPENAI_API_KEY` is set, otherwise a `DisabledAiProvider` that fails
every call with a clear 503 instead of crashing. `AiSqlService.generate()` re-validates the
model's SQL through the same `@sqlpilot/sql-parser` policy before it ever reaches the editor
— a model that ignores instructions still can't produce an executable DROP/INSERT. Chat turns
persist to `Conversation`/`ConversationMessage`; `recentTurns()` sends only the last 8 turns as
context (not the schema on every message). Frontend workspace page: chat pane + editor +
Format/Validate/Explain/Explain(tech)/Optimize/Save/Run, inline validation verdict, error
panel with "Fix with AI", explain/optimize side panel.

**History + saved queries (8):** `QueryHistoryService` (paginated, search, status/connection
filters); `SavedQueriesService` + `PromptTemplate` CRUD. Functional history and saved-queries
pages (search, status filter, pagination, run/duplicate/delete) replacing the earlier
placeholders.

**Charts + analytics (9):** `AnalyticsService.getDashboard()` aggregates connections/history/
saved-queries per user (Mongo aggregation for status breakdown + avg execution time).
`sp-chart` (ECharts): bar/line/area/pie/scatter, theme-aware, auto x/y field inference from
the AI's `visualization` recommendation or column types. Dashboard now shows live stats.

## Phase 10 — security hardening delivered

- **Admin-gated write mode**: `PATCH /databases/:id/write-policy` (ADMIN role only, enforced
  by the global `RolesGuard`) toggles `connection.writeEnabled`; execution still requires the
  global `ALLOW_WRITE_QUERIES` flag on top. Frontend shows the toggle only to admins.
- AI-generated SQL is policy-checked again server-side (see above) — the model is never trusted.
- Request body size capped at 1MB (`express.json({ limit: '1mb' })`).
- Per-route throttling tighter than the global default on `/auth/*` (20/min) and `/ai/*` (20/min).
- Audit log covers connection CRUD/test, schema refresh, AI generation, query
  execute/blocked, login/login-failed/password-changed; `GET /audit` is ADMIN-only.
- Cross-user isolation verified by tests on every resource (connections, schema, history,
  saved queries, conversations).

## Phase 11 — testing delivered

93 tests passing: 8 (`shared`) + 19 (`sql-parser`) + 28 backend unit (auth, tokens, encryption,
query-execution write-policy matrix, schema relevance scoring) + 38 backend e2e across 7 spec
files (auth, app bootstrap, database-connections, schema discovery, query execution incl. the
full USER-blocked/ADMIN-enables/INSERT-succeeds flow, saved queries/prompts/conversations/
analytics, AI-disabled-provider behavior).

## Natural-language answer flow (post-Phase 12)

**Problem:** the assistant only *generated* SQL; nothing executed it, so results never reached the chat.
The only place rows ever appeared was the separate Run button's pane.

**Fix:** `POST /ai/ask` runs the whole chain in one call — generate → policy-validate → execute (read-only) →
analyze the rows → write a plain-language answer from those rows → persist the turn — and returns one stable contract
(`AskResponse` in `@sqlpilot/shared`). The chat renders answer → data → chart → SQL (last, behind a toggle).

Bugs found by driving the real UI against the real model (not visible to unit tests):
1. **Table rendered empty.** `TypeError: isIdLike is not a function` — the dev server served a stale cached CommonJS
   copy of `@sqlpilot/shared`, and the exception aborted rendering mid-table. Fixed at the root: the frontend now compiles
   the shared package's TypeScript *source* (tsconfig path) instead of a prebuilt dist.
2. **Answers accumulated UNIONs across a chat.** Shown the previous query, the model extended it (even when told not to).
   Fixed structurally: a fast follow-up classifier decides whether earlier context is sent at all; fresh questions get a clean
   slate, follow-ups get only the *last* exchange.
3. **Foreign connection ids returned a friendly 200** instead of 404 (error handler swallowed it, and a conversation was
   created first). Ownership is now checked before anything else.

Tests: 19 e2e for `/ai/ask` (scripted model; real DB/execution/analysis) incl. the regressions above; 15 for the
result-analysis decision layer; 11 for the follow-up heuristic. Also verified live with Groq `openai/gpt-oss-120b`,
driving the real UI: all 10 scenario questions in one continuous conversation, plus zero-row, unanswerable and follow-up cases.

## How to verify a phase

```bash
npm run build:packages
npm test
npm run lint --workspace @sqlpilot/backend
npm run test:e2e --workspace @sqlpilot/backend
npm run build --workspace @sqlpilot/frontend
```
