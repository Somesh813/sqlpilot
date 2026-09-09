# Architecture

## Monorepo

npm workspaces. Four framework-agnostic packages under `packages/` are consumed by both
`apps/backend` (NestJS) and, where relevant, `apps/frontend` (Angular). TypeScript path
aliases in `tsconfig.base.json` point at each package's `src/index.ts` for fast local dev;
Docker builds compile the packages first (`npm run build:packages`).

```
packages/shared      → types, enums, DTO contracts, constants, pure utils   (no deps)
packages/sql-parser  → depends on: shared, node-sql-parser
packages/ai          → depends on: shared, openai, zod
packages/database    → depends on: shared, pg, mysql2, better-sqlite3
```

## Backend (NestJS)

Feature modules, one folder each: `auth`, `users`, `database-connections`, `schema`, `ai`,
`sql`, `query-execution`, `query-history`, `saved-queries`, `analytics`, `audit`, `health`.

Cross-cutting:

- `ConfigModule` loads `config/configuration.ts`; `config/env.validation.ts` fails fast.
- `nestjs-pino` for structured logs with a per-request `requestId`.
- `RequestIdMiddleware` assigns/propagates `x-request-id`.
- `AllExceptionsFilter` normalizes every error to `{ statusCode, error, message, requestId }`.
- Global guards: `JwtAuthGuard` (opt out with `@Public()`), `RolesGuard` (`@Roles()`), `ThrottlerGuard`.
- `EncryptionService` (global) — AES-256-GCM for stored external DB credentials.
- `AuditService` (global) — best-effort audit trail; never blocks a request.

### Request lifecycle for a query (phases 5–6)

```
POST /api/queries/execute
  → JwtAuthGuard                     authenticate
  → DTO validation                   shape + confirmed flag
  → QueryExecutionService
      → load DatabaseConnection      decrypt credentials in-memory
      → validateSql(...)             @sqlpilot/sql-parser policy
      → enforce: read-only? write-enabled? risk acceptable?
      → createDriver(config)         @sqlpilot/database
      → driver.runQuery(sql, { timeoutMs, maxRows, page, pageSize })
      → record QueryHistory + AuditLog
  → QueryResult { columns, rows, rowCount, executionTimeMs, truncated }
```

## Frontend (Angular)

Standalone components, signals for state, lazy-loaded routes. `core/` holds singletons
(`ApiService`, `AuthService`, `ThemeService`, interceptors, guards). `shared/ui/` holds
presentational components. Feature folders mirror the backend: `dashboard`, `database`,
`assistant`, `query-editor`, `query-history`, `saved-queries`, `analytics`, `settings`.

Auth: access token in memory + localStorage, refresh token in localStorage; the
`authInterceptor` transparently refreshes on a 401 and queues concurrent requests.

## Data stores

- **MongoDB** — application data only (users, connections, schema snapshots, conversations,
  query history, saved queries, audit logs).
- **External SQL databases** — never modified except when an admin explicitly enables write
  mode; connections are pooled per request and closed afterwards.
