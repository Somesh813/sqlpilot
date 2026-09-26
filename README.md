# SQLPilot

**Ask your database questions in plain English.** SQLPilot connects to PostgreSQL, MySQL or
SQLite, turns a question into a validated read-only query, runs it, and answers with the real
rows, a chart when one makes sense, and a short explanation written from the actual data.

It is built for people who do not write SQL, so the answer comes first and the SQL sits behind a
toggle. It is also built not to trust its own AI: every query is parsed and checked before it
runs, the database itself enforces read-only, and the written answer is verified against the
result before you see it.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)
![Angular 18](https://img.shields.io/badge/angular-18-dd0031)
![NestJS 10](https://img.shields.io/badge/nestjs-10-e0234e)

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Docker](#docker)
- [Security model](#security-model)
- [Architecture](#architecture)
- [API](#api)
- [Testing](#testing)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License](#license)

## How it works

```
question ─▶ schema context ─▶ AI writes SQL ─▶ validate (AST) ─▶ run read-only ─▶ result
                                                                                   │
        answer shown  ◀─ verified against the data ◀─ AI words it ◀─ facts ◀───────┘
```

1. **Schema context.** Small schemas are sent whole. Larger ones are narrowed by meaning and
   joined through the foreign-key graph, so tables like `customers → orders → order_items → products`
   are all present even when the question only names two of them.
2. **SQL generation.** The model returns structured JSON (SQL, assumptions, confidence), never free text.
3. **Validation.** The SQL is parsed into an AST and rejected unless it is a single `SELECT`
   (or `WITH` over `SELECT`s). See the [security model](#security-model).
4. **Execution.** The query runs inside a real read-only transaction with a timeout, fetching at
   most 1,000 rows plus one, so truncation is detected exactly and never silent.
5. **Answer.** Deterministic code analyses the result and picks the view. The model only words
   the answer, and any number or claim that contradicts the data is replaced by a plain, true sentence.

## Features

- **Chat-style assistant.** Follow-ups work: "only the top 5", "filter those to Mumbai", "remove the filter", "show it as a chart".
- **Real results.** Table with sorting, wide-table scrolling and CSV export; bar, line, area, pie and scatter charts (ECharts) chosen from the shape of the data.
- **Honest about limits.** "Showing 1,000 of 1,500 rows." or "Showing the first 1,000 rows. More results are available."
- **SQL workspace.** Editor with generate, validate, explain, optimize, and "fix with AI" for failing queries.
- **Connections.** PostgreSQL, MySQL and SQLite with encrypted credentials, schema discovery, and warnings when an account has more privileges than it needs.
- **History and saved queries,** per-user isolation, audit log for admins.
- **Accounts.** Register, login, rotating refresh tokens with reuse detection, password reset by email, `USER` and `ADMIN` roles.
- **Two AI providers.** OpenAI or Groq, switched by one setting.

## Quick start

You need **Node 20+**, **npm 10+**, MongoDB, and an API key for OpenAI or Groq.

```bash
git clone https://github.com/<your-user>/sqlpilot.git
cd sqlpilot
npm install
cp .env.example .env
```

Generate the secrets and paste them into `.env`:

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

Add an AI key (`OPENAI_API_KEY`, or `GROQ_API_KEY` with `AI_PROVIDER=groq`), then start MongoDB and the apps:

```bash
# MongoDB: a local install works (DATABASE_URL=mongodb://localhost:27017/sqlpilot),
# or use the bundled container (needs MONGO_ROOT_PASSWORD and MONGO_APP_PASSWORD in .env):
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d mongo

npm run build:packages     # compile the shared workspace packages (re-run after changing them)
npm run dev:backend        # API      http://localhost:3000/api
npm run dev:frontend       # Web app  http://localhost:4200
```

Open <http://localhost:4200>, create an account, and add a connection.

**Trying it with SQLite.** SQLite files must live in an approved directory. In development that
is `apps/backend/data/sqlite` (change it with `SQLITE_ALLOWED_DIRS`). Copy a `.sqlite` file
there and use its full path when adding the connection.

**Password reset in development.** Emails are written to `apps/backend/data/outbox/` instead of
being sent. Open the newest file to get the link.

## Configuration

Everything is set through environment variables. The API validates them on boot and refuses to
start on a missing or malformed value. In production it also rejects placeholder secrets,
all-zero encryption keys, and MongoDB URLs without credentials.

| Variable | Required | Description |
| --- | :---: | --- |
| `DATABASE_URL` | yes | MongoDB connection string for application data |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | yes | Token signing secrets. Must differ; 32+ characters in production |
| `ENCRYPTION_KEY` | yes | 64 hex characters. AES-256-GCM key for stored connection credentials |
| `AI_PROVIDER` | | `openai` (default) or `groq` |
| `OPENAI_API_KEY` / `GROQ_API_KEY` | prod | Key for the selected provider. Without it, AI routes answer 503 |
| `OPENAI_MODEL`, `OPENAI_MODEL_FAST`, `GROQ_MODEL`, `GROQ_MODEL_FAST` | | Model ids |
| `AI_SEND_ROW_VALUES` | | `true` (default) lets a scrubbed sample of each result reach the AI provider to word the answer; `false` sends no result values at all |
| `AI_MAX_SCHEMA_TABLES` | | Tables sent to the model before narrowing kicks in (default `25`) |
| `QUERY_TIMEOUT_MS` | | Per-query timeout (default `15000`) |
| `QUERY_MAX_ROWS` | | Row cap (default `1000`) |
| `ALLOW_WRITE_QUERIES` | | Global kill switch for writes in the SQL editor (default `false`) |
| `DB_POOL_MAX_CONNECTIONS`, `DB_POOL_IDLE_MS`, `DB_POOL_MAX_DRIVERS` | | Persistent pool per database connection: size (default `5`), idle close time (default 5 min), pools kept (default `50`) |
| `SQLITE_ALLOWED_DIRS` | | Comma-separated directories SQLite files must live in (default `./data/sqlite`) |
| `DB_ALLOWED_HOSTS` | | Optional allowlist of database hosts: names, `*.suffix`, IPs, CIDRs |
| `DB_BLOCK_PRIVATE_HOSTS` | | Refuse loopback, private and cloud-metadata addresses. Defaults to `true` in production |
| `TRUST_PROXY_HOPS` | | Reverse proxies whose `X-Forwarded-For` entry is trusted (default `0`, `1` behind the bundled nginx) |
| `MAIL_TRANSPORT` | | `smtp`, `file` (dev outbox, refused in production) or `none` (production default) |
| `MAIL_SMTP_URL`, `MAIL_FROM`, `APP_BASE_URL` | | SMTP connection, sender, and the public URL used in emailed links |
| `CORS_ORIGIN`, `PORT`, `LOG_LEVEL` | | Allowed origins, API port, log level |

See [`.env.example`](./.env.example) for the full list with comments.

## Docker

```bash
cp .env.example .env    # set the secrets, MONGO_ROOT_PASSWORD, MONGO_APP_PASSWORD (openssl rand -hex 24), and an AI key
docker compose up --build
```

- The web app and API are served through nginx on <http://localhost:8080>. That is the only published port, bound to loopback. Put a TLS-terminating proxy in front, or set `WEB_BIND=0.0.0.0` on purpose.
- MongoDB and the API container are not reachable from the host.
- There are no default passwords. Compose refuses to start while a secret is unset.
- SQLite files go in the `sqlite-data` volume (`/app/data/sqlite`).
- Password-reset email needs `MAIL_TRANSPORT=smtp` and `MAIL_SMTP_URL`. Until then the feature is off and nothing sensitive is logged.
- An existing Mongo volume keeps its old credentials. Reset the volume or create the app user by hand when moving to this setup.

## Security model

SQLPilot connects to real databases on behalf of users and runs AI-written SQL, so it uses layers
that each stand on their own.

| Layer | What it does |
| --- | --- |
| AST validation | One statement only, and it must be a `SELECT` or a `WITH` over `SELECT`s. Rejects `INSERT`, `UPDATE`, `DELETE`, DDL, `GRANT`/`REVOKE`, `SELECT INTO`, `FOR UPDATE`, nested data-modifying CTEs, and about 100 dangerous functions (`pg_read_file`, `lo_import`, `dblink`, `pg_sleep`, `nextval`, `LOAD_FILE`, `SLEEP`, `load_extension` and more). Anything it cannot parse is rejected. |
| Dialect-aware lexing | Comments are removed using each engine's real rules (`#` in MySQL, nested comments in PostgreSQL, dollar-quotes). The text that is validated is exactly the text that runs. |
| Database-enforced read-only | PostgreSQL `BEGIN READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite `query_only`. A last-line check also refuses `COPY … PROGRAM`, which a read-only transaction does not stop for a superuser. |
| Resource limits | Statement timeout, row cap by fetching `limit + 1`, and SQLite queries in a child process that is killed on timeout so a heavy query cannot freeze the API. |
| Connection policy | SQLite files only inside approved directories (symlinks resolved, one uniform error). Network hosts checked against an allowlist or blocked if private, loopback or metadata. Errors shown to users are generic. |
| Credentials | Encrypted with AES-256-GCM at rest, decrypted only in the backend, never returned. Passwords hashed with bcrypt. |
| Auth | Short-lived access tokens, rotating refresh tokens with reuse detection, per-client rate limits that work behind a reverse proxy. |
| AI data minimisation | The model sees the schema (names and types only, never values), the question, and the earlier SQL, not earlier answers. For wording an answer it gets at most 20 rows, 10 columns and 60-character cells, with secret columns dropped, identifier columns dropped, contact and identity columns shown as `[hidden]`, and credential-, card-, phone- and email-shaped values scrubbed. A final guard removes anything credential-shaped from every outbound request. The full result never leaves the server. |
| Answer grounding | Numbers and "no results" claims in the AI's answer are checked against the data. A wrong answer is replaced by a deterministic one. |
| Deployment | No default secrets, no published database or API ports, internal Docker network, read-only backend container. |

**Recommended:** connect with a dedicated read-only database account. SQLPilot warns when the
account is a PostgreSQL superuser or a MySQL user with write or admin grants.

Details are in [`docs/security.md`](./docs/security.md). To report a vulnerability, please open a
private security advisory on GitHub instead of a public issue.

## Architecture

```
Browser ──▶ Angular SPA ──▶ nginx ──▶ NestJS API ──▶ MongoDB   (users, connections, history, audit)
                                          │
                                          └──▶ your PostgreSQL / MySQL / SQLite
```

npm workspaces monorepo:

```
sqlpilot/
├── apps/
│   ├── backend/          NestJS API: auth, connections, schema, AI, query execution, history
│   └── frontend/         Angular 18 SPA (standalone components, signals, Tailwind, ECharts)
├── packages/
│   ├── shared/           Contracts, result analysis, schema selection, answer verification
│   ├── sql-parser/       Lexer, AST inspection and the security policy
│   ├── ai/               Provider abstraction (OpenAI / Groq), prompts, output schemas
│   └── database/         PostgreSQL / MySQL / SQLite drivers and schema introspection
├── docker/               Dockerfiles, nginx config, Mongo init script
├── docs/                 Architecture and security notes
└── docker-compose.yml
```

More in [`docs/architecture.md`](./docs/architecture.md).

## API

Base path `/api`. Every route needs a Bearer token except the public auth routes and `/health`.
The assistant's main call is `POST /ai/ask`:

```jsonc
// request
{ "connectionId": "…", "question": "Show the top 10 customers by spending", "conversationId": "…" }

// response
{
  "success": true,
  "sql": "SELECT …",
  "columns": ["customer_name", "total_spending"],
  "rows": [{ "customer_name": "Kabir", "total_spending": 229500 }],
  "returnedRows": 10,          // rows in `rows`
  "totalRows": 10,             // exact total when known, otherwise null
  "truncated": false,          // true when the database had more rows than were returned
  "resultType": "categorical", // empty | single_value | table | categorical | time_series | …
  "visualization": { "recommended": true, "type": "bar", "xColumn": "customer_name", "yColumns": ["total_spending"] },
  "availableViews": ["bar", "pie", "table"],
  "explanation": "The top 10 customers by spending are …",
  "error": null                // or { stage, message, technical }
}
```

Expected failures (not understood, unsafe SQL, database error) come back as `200` with
`success: false` and a friendly `explanation`, so the UI always has something to show.

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register`, `login`, `refresh`, `logout`, `forgot-password`, `reset-password`, `change-password`; `GET /auth/profile` |
| Connections | `GET/POST /databases`, `POST /databases/test`, `GET/PATCH/DELETE /databases/:id`, `POST /databases/:id/test`, `GET /databases/:id/schema`, `POST /databases/:id/schema/refresh` |
| Queries | `POST /queries/validate`, `POST /queries/execute`, history and saved-query routes under `/queries` |
| AI | `POST /ai/ask`, `generate-sql`, `explain-sql`, `optimize-sql`, `fix-sql` |
| Other | `/conversations`, `/analytics/dashboard`, `/health`, `GET /audit` (admin) |

## Testing

```bash
npm test                # unit tests for every package and the backend
npm run test:e2e        # backend end-to-end tests (in-memory MongoDB)
npm run build           # packages, backend and frontend
```

The PostgreSQL driver tests start a real PostgreSQL server automatically (`embedded-postgres`),
or use your own by setting `PG_TEST_URL`. The security suite covers `DROP`, `DELETE`, `UPDATE`,
`INSERT`, `ALTER`, `TRUNCATE`, `SELECT INTO`, nested and comment-hidden SQL, dangerous functions,
huge and nested `LIMIT`s and stacked statements, and the driver tests check that the database
itself refuses them.

## Project status

SQLPilot is under active development. The core flow works end to end. A security and
reliability review is being worked through in phases:

- Done: SQL security (AST validation, real read-only transactions, exact row caps), schema
  selection, grounded answers, truncation handling, killable SQLite queries, connection policy,
  proxy handling, password-reset email, deployment hardening.
- In progress: safe user-facing error messages, connection pooling, minimizing data sent to the
  AI provider, schema validation of generated SQL, broader MySQL and frontend test coverage.

MySQL support is implemented but has less automated test coverage than PostgreSQL and SQLite.
[`PROGRESS.md`](./PROGRESS.md) has the detailed history.

## Contributing

Issues and pull requests are welcome.

1. Fork and create a branch.
2. `npm install && npm run build:packages`, then make your change.
3. Add or update tests. Anything that touches SQL validation or the drivers needs a test that shows a bad statement being refused.
4. Run `npm test`, `npm run test:e2e` and `npm run build` before opening the PR.

Please never commit `.env` or real credentials.

## License

[MIT](./LICENSE)
