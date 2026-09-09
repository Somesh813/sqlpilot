# SQLPilot

**AI-powered SQL assistant.** Connect a database, ask questions in natural language, and get
schema-aware SQL that is validated, explained, and safely executed — with results, charts,
history, and optimization suggestions in one workspace.

> Status: **Phase 1–2 complete** (project architecture + authentication). See
> [`PROGRESS.md`](./PROGRESS.md) for the phase-by-phase roadmap.

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
| AI Assistant | Natural-language → SQL, structured JSON output, assumptions, confidence, warnings, conversation context |
| SQL editor | Monaco editor with formatting, generate / explain / optimize / run |
| Execution | SQL parse → validation → security policy → user confirmation → execution; timeout, row limits, pagination |
| Results | Sortable / filterable grid, column controls, CSV / JSON / Excel export |
| Visualization | AI-recommended bar / line / pie / area / scatter / KPI charts |
| Explain / Optimize / Fix | Simple + technical explanations, advisory optimization, error-driven repair |
| History & saved queries | Searchable history, favorites with tags |
| Observability | Structured logging, request IDs, health endpoint, audit log |

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

- **Frontend:** Angular 18 (standalone + signals), TypeScript, RxJS, Tailwind CSS, Angular CDK/Material, Monaco Editor, ECharts
- **Backend:** Node.js 20, NestJS 10, REST, Mongoose, Passport JWT, `class-validator`, Helmet, pino
- **AI:** OpenAI API with JSON-schema structured outputs and prompt templates
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
│   ├── ai/             OpenAI provider abstraction + prompt templates + output schemas
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
| `OPENAI_API_KEY` | prod | OpenAI key (required in production) |
| `OPENAI_MODEL` / `OPENAI_MODEL_FAST` | – | Model ids |
| `QUERY_TIMEOUT_MS` | – | Per-query timeout (default `15000`) |
| `QUERY_MAX_ROWS` | – | Max rows returned (default `1000`) |
| `ALLOW_WRITE_QUERIES` | – | Global kill switch for write statements (default `false`) |

The API validates these on boot and refuses to start if a required value is missing or malformed.

## Running locally

```bash
# 1. Start MongoDB. Either use a local install (DATABASE_URL=mongodb://localhost:27017/sqlpilot)
#    or the bundled container (DATABASE_URL=mongodb://root:root@localhost:27017/sqlpilot?authSource=admin):
docker compose up -d mongo

# 2. Backend  →  http://localhost:3000/api
npm run dev:backend

# 3. Frontend →  http://localhost:4200  (proxies /api to the backend)
npm run dev:frontend
```

## Docker

```bash
cp .env.example .env    # fill in JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY, OPENAI_API_KEY
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

### Planned (later phases)

`/databases`, `/databases/:id/test`, `/databases/:id/schema`, `/ai/generate-sql`,
`/ai/explain-sql`, `/ai/optimize-sql`, `/ai/fix-sql`, `/queries/validate`, `/queries/execute`,
`/queries/history`, `/queries/saved`, `/conversations`, `/analytics/dashboard`.

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
(`OpenAiProvider` is the implementation). Feature services compose prompt templates
(`buildSqlGenerationMessages`, `buildSqlExplanationMessages`, …) and request **structured
JSON** validated against Zod schemas — no free-text parsing. The backend `SchemaContextService`
(Phase 6) selects only the tables relevant to a question so large schemas do not blow the
context window.

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
