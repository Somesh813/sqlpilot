# SQLPilot

**AI-powered SQL assistant.** Connect a database, ask questions in natural language, and get
schema-aware SQL that is validated, explained, and safely executed — with results, charts,
history, and optimization suggestions in one workspace.

> Status: **Phases 1–11 complete** (architecture, auth, connections, schema discovery, SQL
> editor/execution, AI generation/explain/optimize/fix, history, saved queries, charts,
> security hardening, tests). 93 tests passing. Phase 12 (production Docker polish) is in
> progress. See [`PROGRESS.md`](./PROGRESS.md) for the phase-by-phase detail.

---

## Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally)
- [Docker](#docker)
- [API](#api)
- [Security model](#security-model)
- [AI architecture](#ai-architecture)
- [Database support](#database-support)
- [Testing](#testing)
- [Screenshots](#screenshots)
- [Future improvements](#future-improvements)

---

## Overview

SQLPilot lets a user connect PostgreSQL, MySQL, or SQLite databases, inspect their schema,
and ask questions like _"show me the top 10 customers by total spending this year"_. The AI
uses only the relevant slice of the schema to produce a **single read-only SELECT**, which is
parsed, validated against a security policy, shown to the user for review and editing, and
only then executed with a timeout and row cap. Results render in a professional data grid
with export and charting, and the AI can explain, optimize, or repair any query.

## Features

| Area | Capability |
| --- | --- |
| Auth | Register, login, logout, refresh-token rotation with reuse detection, forgot/reset password, change password, `USER` / `ADMIN` roles |
| Connections | Add / test / edit / delete PostgreSQL, MySQL, SQLite connections; encrypted credentials; connection status |
| Schema | Automatic discovery of tables, columns, types, keys, indexes, relationships |
| AI Assistant | Natural-language → SQL, structured JSON output, assumptions, confidence, warnings, conversation context (only relevant tables sent, not the whole schema) |
| SQL editor | Line-numbered editor with formatting, generate / validate / explain / optimize / run, Ctrl+Enter to run |
| Execution | SQL parse → validation → security policy → user confirmation → execution; timeout, row limits, pagination |
| Results | Sortable / filterable grid, cell copy, CSV / JSON export, server-side pagination |
| Visualization | AI-recommended bar / line / area / pie / scatter charts (ECharts), theme-aware |
| Explain / Optimize / Fix | Simple + technical explanations, advisory optimization, error-driven repair ("Fix with AI") |
| History & saved queries | Searchable/filterable history, favorites with tags, reusable prompt templates |
| Admin write policy | Per-connection write toggle (ADMIN-only) gated by a global kill switch |
| Observability | Structured logging, request IDs, health endpoint, audit log (ADMIN-viewable) |

## Architecture

```
                    ┌────────────────────────┐
   Browser  ─────▶  │  Angular SPA (frontend) │
                    └───────────┬────────────┘
                                │ REST / SSE  (JWT)
                    ┌───────────▼────────────┐        ┌──────────────┐
                    │   NestJS API (backend) │ ─────▶ │  MongoDB     │  app data
                    │                        │        └──────────────┘
                    │  auth · connections ·  │
                    │  schema · ai · sql ·   │        ┌──────────────────────────┐
                    │  query-execution ·     │ ─────▶ │ External SQL DBs         │
                    │  history · audit       │        │ Postgres / MySQL / SQLite│
                    └───────────┬────────────┘        └──────────────────────────┘
                                │
             ┌──────────────────┼─────────────────────┐
             ▼                  ▼                     ▼
     @sqlpilot/ai       @sqlpilot/sql-parser    @sqlpilot/database
   prompt templates,    AST parse, statement    driver adapters +
   OpenAI provider,     classification,         schema introspection
   structured output    security policy
```

Every generated query flows through:

```
AI generation → SQL parser → SQL validation → security policy → user confirmation → execution
```

## Tech stack

- **Frontend:** Angular 18 (standalone + signals), TypeScript, RxJS, Tailwind CSS, ECharts, a small dependency-free SQL editor component
- **Backend:** Node.js 20, NestJS 10, REST, Mongoose, Passport JWT, `class-validator`, Helmet, pino
- **AI:** OpenAI **or Groq** (switch with `AI_PROVIDER`) with JSON-schema structured outputs and prompt templates
- **Databases:** MongoDB (application data); PostgreSQL / MySQL / SQLite (external, user-connected)
- **Infra:** Docker + Docker Compose
- **Testing:** Jest, Supertest, `mongodb-memory-server`, Karma/Jasmine

## Repository layout

```
sqlpilot/
├── apps/
│   ├── backend/        NestJS API
│   └── frontend/       Angular SPA
├── packages/
│   ├── shared/         Types, enums, DTO contracts, constants shared front↔back
│   ├── sql-parser/     SQL AST parsing + security validation (unit-tested)
│   ├── ai/             OpenAI/Groq provider abstraction + prompt templates + output schemas
│   └── database/       Postgres/MySQL/SQLite drivers + schema introspection
├── docker/             Dockerfiles, nginx config, mongo init
├── docs/               Architecture and security notes
├── docker-compose.yml
├── .env.example
└── PROGRESS.md
```

## Getting started

Requires **Node 20+** and **npm 10+** (and Docker if you want the containerized stack).

```bash
git clone <this-repo> sqlpilot
cd sqlpilot
cp .env.example .env      # then fill in secrets — see below
npm install
npm run build:packages    # compile the shared workspace packages
```

Generate secrets:

```bash
# JWT secrets
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Encryption key (must be 64 hex chars / 32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | – | `development` \| `test` \| `production` |
| `PORT` | – | API port (default `3000`) |
| `CORS_ORIGIN` | – | Comma-separated allowed origins |
| `DATABASE_URL` | ✅ | MongoDB connection string for application data |
| `JWT_SECRET` | ✅ | Access-token signing secret |
| `JWT_REFRESH_SECRET` | ✅ | Refresh-token signing secret (must differ from `JWT_SECRET`) |
| `JWT_ACCESS_EXPIRES_IN` | – | e.g. `15m` |
| `JWT_REFRESH_EXPIRES_IN` | – | e.g. `7d` |
| `ENCRYPTION_KEY` | ✅ | 64 hex chars — AES-256-GCM key for stored DB credentials |
| `AI_PROVIDER` | – | `openai` (default) or `groq` |
| `OPENAI_API_KEY` | prod* | OpenAI key (required in production when `AI_PROVIDER=openai`) |
| `GROQ_API_KEY` | prod* | Groq key (required in production when `AI_PROVIDER=groq`) |
| `GROQ_MODEL` / `GROQ_MODEL_FAST` | – | Default `openai/gpt-oss-120b` / `openai/gpt-oss-20b` |
| `AI_STRUCTURED_OUTPUT_MODE` | – | `json_schema` (default) or `json_object` for models without strict-schema support |
| `OPENAI_MODEL` / `OPENAI_MODEL_FAST` | – | Model ids |
| `QUERY_TIMEOUT_MS` | – | Per-query timeout (default `15000`) |
| `QUERY_MAX_ROWS` | – | Max rows returned (default `1000`) |
| `ALLOW_WRITE_QUERIES` | – | Global kill switch for write statements (default `false`) |

The API validates these on boot and refuses to start if a required value is missing or malformed.

## Running locally

```bash
# 1. Start MongoDB. Either use a local install (DATABASE_URL=mongodb://localhost:27017/sqlpilot)
#    or the bundled container (DATABASE_URL=mongodb://sqlpilot:sqlpilot@localhost:27017/sqlpilot?authSource=sqlpilot):
docker compose up -d mongo

# 2. Backend  →  http://localhost:3000/api
npm run dev:backend

# 3. Frontend →  http://localhost:4200  (proxies /api to the backend)
npm run dev:frontend
```

## Docker

```bash
cp .env.example .env    # fill in JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY, and OPENAI_API_KEY or GROQ_API_KEY (+ AI_PROVIDER=groq)
docker compose up --build
```

- Frontend: <http://localhost:8080>
- API: <http://localhost:3000/api>
- Mongo: `localhost:27017`

## API

Base path: `/api`. All routes require a `Bearer` access token except the ones marked _public_.

### Auth

| Method | Path | Public | Description |
| --- | --- | :---: | --- |
| POST | `/auth/register` | ✅ | Create account, returns tokens |
| POST | `/auth/login` | ✅ | Returns tokens |
| POST | `/auth/refresh` | ✅ | Rotate refresh token |
| POST | `/auth/logout` | ✅ | Revoke a refresh token |
| POST | `/auth/forgot-password` | ✅ | Issue reset token |
| POST | `/auth/reset-password` | ✅ | Reset with token |
| GET | `/auth/profile` | | Current user |
| POST | `/auth/change-password` | | Change password, revokes sessions |
| GET | `/health` | ✅ | Liveness + Mongo + memory checks |

### Databases & schema

| Method | Path | Notes |
| --- | --- | --- |
| GET / POST | `/databases` | List / create a connection |
| POST | `/databases/test` | Test connection params before saving |
| GET / PATCH / DELETE | `/databases/:id` | Manage one connection |
| POST | `/databases/:id/test` | Re-test a stored connection |
| PATCH | `/databases/:id/write-policy` | **ADMIN only** — enable/disable write statements |
| GET | `/databases/:id/schema` | Cached schema snapshot (discovers on first read) |
| POST | `/databases/:id/schema/refresh` | Force re-discovery |

### Queries

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/queries/validate` | Run the security policy without executing |
| POST | `/queries/execute` | Validate → policy → `confirmed:true` required → execute |
| GET | `/queries/history` | Paginated, filterable by connection/status/search |
| DELETE | `/queries/history/:id` | Remove one entry |
| POST | `/queries/save` · GET `/queries/saved` · PATCH/DELETE `/queries/saved/:id` | Saved queries |
| GET/POST `/prompts` · DELETE `/prompts/:id` | Reusable prompt templates |

### AI

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/ai/ask` | **The assistant's main call.** Natural language in → answer, real rows, result type and chart recommendation out (see contract below) |
| POST | `/ai/generate-sql` | NL → structured SQL only (no execution); appends to the conversation if `conversationId` is given |
| POST | `/ai/explain-sql` | `mode: "simple" \| "technical"` |
| POST | `/ai/optimize-sql` | Advisory optimization with a disclaimer, never a guarantee |
| POST | `/ai/fix-sql` | Given the failing SQL + database error, returns a corrected query |

#### `POST /ai/ask` response contract

```jsonc
{
  "success": true,
  "question": "Show the top 10 customers by spending",
  "conversationId": "…",
  "sql": "SELECT …",
  "columns": ["customer_name", "total_spending"],
  "rows": [{ "customer_name": "Kabir", "total_spending": 229500 }],
  "rowCount": 10, "totalRowCount": 10, "truncated": false, "executionTimeMs": 3,
  "resultType": "categorical",   // empty | single_value | table | categorical | time_series | multi_series | percentage_distribution | correlation
  "visualization": { "recommended": true, "type": "bar", "xColumn": "customer_name", "yColumns": ["total_spending"] },
  "availableViews": ["bar", "pie", "table"],   // only views that make sense for this data
  "explanation": "The top 10 customers by spending are…",   // plain-language answer written from the ACTUAL rows
  "queryExplanation": "…", "assumptions": [], "warnings": [], "autoFixed": false,
  "error": null   // or { stage: "generation" | "execution", message, technical }
}
```

Handled failures (not understood, unsafe SQL, database error) return **200** with `success: false` and a
friendly `explanation`, so the UI always has something to show. A DB error is repaired automatically once.
The chart type is decided by `analyzeResult()` in `@sqlpilot/shared` (deterministic; the model's opinion is only a hint),
so a chart is never recommended for a single value, free text, or ID-only data.

Every AI endpoint returns **503** with a clear message (never a crash) when the selected provider's key
(`OPENAI_API_KEY` / `GROQ_API_KEY`) is unset. AI-generated SQL is re-validated by `@sqlpilot/sql-parser` before it's ever returned.

### Conversations & analytics

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST `/conversations` · GET/DELETE `/conversations/:id` | AI chat sessions |
| GET | `/analytics/dashboard` | Per-user stats for the dashboard |
| GET | `/audit` | **ADMIN only** — audit log |

## Security model

- **Credentials never reach the browser.** External DB passwords are AES-256-GCM encrypted
  at rest (`EncryptionService`) and only decrypted inside the backend at query time.
- **AI SQL is never executed blindly.** `@sqlpilot/sql-parser` parses each statement to an
  AST, classifies it (`READ` / `WRITE` / `DDL` / `DCL` / …), and applies a policy:
  - `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, and similar are **always blocked**.
  - `INSERT` / `UPDATE` / `DELETE` are blocked unless an admin enables write mode for the
    connection **and** `ALLOW_WRITE_QUERIES=true`.
  - Stacked statements, `INTO OUTFILE`, and locking reads are rejected.
  - String literals and comments are stripped before keyword scanning so payloads cannot hide inside them.
  - A `LIMIT` is injected into limit-less `SELECT`s.
- **Execution guards:** statement timeout, max row count, pagination, read-only transaction
  where the engine supports it.
- **Auth:** bcrypt (12 rounds), short-lived access tokens, rotating refresh tokens with
  reuse detection, uniform "invalid email or password" responses.
- **Audit log:** connection changes, query execution, blocked queries, logins.

See [`docs/security.md`](./docs/security.md) for details.

## AI architecture

The `@sqlpilot/ai` package isolates all model interaction behind an `AiProvider` interface
(`OpenAiProvider` is the implementation; Groq exposes an OpenAI-compatible API, so
`AI_PROVIDER=groq` reuses the same client pointed at `https://api.groq.com/openai/v1`. A
`DisabledAiProvider` is bound instead when the selected provider's key is unset, so the API
still boots and every AI route answers 503 rather than crashing). Feature services compose prompt templates (`buildSqlGenerationMessages`,
`buildSqlExplanationMessages`, …) and request **structured JSON** validated against Zod
schemas — no free-text parsing. `SchemaService.buildContext()` keyword-scores tables/columns
against the question, pulls in directly related tables via foreign keys, and caps the result
at `AI_MAX_SCHEMA_TABLES` so large schemas never blow the context window. Every model-generated
query is re-validated by `@sqlpilot/sql-parser` before it is returned to the client.

## Database support

| Engine | Driver | Schema introspection | Notes |
| --- | --- | --- | --- |
| PostgreSQL | `pg` | `information_schema` + `pg_*` | `SET statement_timeout`, read-only tx |
| MySQL | `mysql2` | `information_schema` | `MAX_EXECUTION_TIME` hint |
| SQLite | `better-sqlite3` | `PRAGMA` | file path on the backend host; opened read-only |

## Testing

```bash
npm test                     # all workspaces
npm run test:backend         # backend unit tests
npm run test --workspace @sqlpilot/sql-parser   # security policy tests
npm run test:e2e --workspace @sqlpilot/backend  # auth flow against in-memory Mongo
```

## Screenshots

_Add screenshots of the dashboard, assistant, and results grid here as phases land._

## Future improvements

- httpOnly-cookie refresh tokens
- SSO / OAuth login
- Streaming AI responses over SSE in the assistant UI
- Query result caching and scheduled queries
- More engines (SQL Server, BigQuery, Snowflake)
- Row-level access policies per connection
- Team workspaces and shared saved queries
