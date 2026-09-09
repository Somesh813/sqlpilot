# SQLPilot — build progress

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Project setup + architecture (monorepo, shared packages, config, common infra, health, Docker) | ✅ Done |
| 2 | Authentication (register, login, refresh rotation, forgot/reset, change password, roles, guards; frontend auth flow + shell + dashboard skeleton) | ✅ Done |
| 3 | Database connection manager (CRUD, encrypted credentials, test connection, status) | ⏳ Next |
| 4 | Schema discovery (introspection endpoints, explorer sidebar) | ◻ Planned |
| 5 | SQL editor + query execution (Monaco, validate → policy → confirm → execute, results grid) | ◻ Planned |
| 6 | AI SQL generation (schema context selection, structured output, conversations) | ◻ Planned |
| 7 | AI explanation + optimization + fix-with-AI | ◻ Planned |
| 8 | Query history + saved queries + reusable prompts | ◻ Planned |
| 9 | Charts + analytics dashboard | ◻ Planned |
| 10 | Security hardening pass (rate limits, audit coverage, red-team the parser) | ◻ Planned |
| 11 | Testing (unit + integration across modules) | ◻ Planned |
| 12 | Docker + production configuration polish | ◻ Planned |

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
| Backend e2e (in-memory Mongo) | `npm run test:e2e` | ✅ 8/8 (auth flow + full AppModule bootstrap) |
| Frontend production build | `npm run build --workspace @sqlpilot/frontend` | ✅ |

**53 tests passing.**

## How to verify a phase

```bash
npm run build:packages
npm test
npm run lint --workspace @sqlpilot/backend
npm run test:e2e --workspace @sqlpilot/backend
npm run build --workspace @sqlpilot/frontend
```
