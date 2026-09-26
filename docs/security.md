# Security model

## Credentials

- External database credentials are submitted once when creating/editing a connection and
  are **immediately AES-256-GCM encrypted** (`EncryptionService`) using `ENCRYPTION_KEY`
  (32 bytes, hex). Ciphertext layout: `base64([12-byte IV][16-byte GCM tag][ciphertext])`.
- The decrypted form exists only transiently inside a single backend request while a driver
  connection is open. It is never logged, never serialized to a response, and never stored.
- `SafeDatabaseConnection` (the browser-facing shape) has no password/credential field.

## AI-generated SQL pipeline

```
AI generation → SQL parser → SQL validation → security policy → user confirmation → execution
```

1. **Generation** — the model is instructed to emit a single read-only `SELECT` and to set
   `unanswerable: true` rather than invent tables/columns. Output is JSON validated by a Zod schema.
2. **Lex** (`lexSql`) — comments are removed using the target engine's real rules (`#` is a
   comment only in MySQL, PostgreSQL nests block comments, dollar-quotes and `E''` strings are
   understood, MySQL `/*! */` bodies are dropped). The cleaned text is what is validated **and**
   what is executed, so a comment cannot mean one thing to the validator and another to the database.
3. **Parse and validate** (`validateSql`) — `node-sql-parser` builds an AST for the dialect and a
   recursive walk applies the policy. **A statement that cannot be parsed is rejected.**
   - Exactly one statement, and it must be a `SELECT` (or `WITH` over `SELECT`s).
   - **Always rejected:** DDL, `GRANT`/`REVOKE`, `SET`, `CALL`/`EXEC`, transaction control,
     `COPY`, `ATTACH`, `PRAGMA`, `SHOW`, and any nested statement (data-modifying CTEs).
   - **Rejected:** `SELECT ... INTO` (tables, variables, `OUTFILE`/`DUMPFILE`),
     `FOR UPDATE` / `FOR SHARE`, stacked statements.
   - **Dangerous functions** are rejected wherever they appear (select list, `FROM`, `WHERE`,
     subqueries, CTEs), by exact name and by family: file access (`pg_read_file`, `lo_import`,
     `LOAD_FILE`, `readfile`), outbound connections and code (`dblink*`), session and server
     control (`pg_terminate_backend`, `set_config`), sleeps and locks (`pg_sleep`, `SLEEP`,
     `BENCHMARK`, `GET_LOCK`, `pg_advisory_*`), sequences (`nextval`, `setval`), `load_extension`.
   - `INSERT`/`UPDATE`/`DELETE` are allowed **only** in the manual SQL editor, one statement at a
     time, when the connection is write-enabled by an ADMIN **and** `ALLOW_WRITE_QUERIES=true`.
     The AI path is always read-only (`forceReadOnly`).
   - No `LIMIT` is appended or rewritten. Returns `{ valid, statementKind, risk, referencedTables,
     referencedColumns, functionsUsed, topLevelLimit, violations, normalizedSql }`.
4. **User confirmation** — the API requires `confirmed: true` on `/queries/execute`; the UI
   shows the (possibly edited) SQL and the validation verdict first.
5. **Execution** — the database enforces read-only itself: PostgreSQL `BEGIN READ ONLY` (with the
   first snapshot taken so it cannot be switched back), MySQL `START TRANSACTION READ ONLY`,
   SQLite `query_only`. Drivers also refuse anything that is not `SELECT`/`WITH`/`VALUES`/`TABLE`,
   because a read-only transaction does not stop `COPY ... PROGRAM` for a superuser. Rows are
   fetched as `maxRows + 1` (cursor, stream, iterator) so truncation is exact and a huge table is
   never loaded. SQLite runs in a child process that is killed on timeout or cancellation.
   Execution time and row count are recorded to `QueryHistory` and `AuditLog`.

## Authentication

- Passwords hashed with bcrypt, cost 12.
- Access tokens: JWT, short TTL (default 15m), `HS256`.
- Refresh tokens: opaque 48-byte random, stored only as SHA-256 hash, single-use. Rotation
  marks the old row `revoked` and links `replacedByHash`. Presenting an already-rotated
  token revokes the **entire family** for that user (reuse detection).
- Login returns a uniform `Invalid email or password.` regardless of whether the account exists.
- `forgot-password` always succeeds silently; the reset token is single-use, hashed, 1-hour TTL.
- Changing a password revokes all refresh tokens for the user.

## Transport & headers

- `helmet()` default headers.
- CORS restricted to `CORS_ORIGIN`.
- Global rate limiting via `@nestjs/throttler` (120 req/min baseline; auth routes tightened).

## Audit log

`audit_logs` collection, capped by a `createdAt` index. Events: connection created/updated/
deleted/tested, schema refreshed, AI SQL generated, query validated/executed/blocked, saved
query created/deleted, login, login failed, password changed. String values are run through
`redactSecrets()` before persistence.

## Known limitations (tracked)

- Refresh tokens live in `localStorage` in this build — move to an httpOnly cookie for
  production-grade XSS resistance.
- Dialect coverage of `node-sql-parser` is not total. Unparseable SQL is rejected (fail closed),
  which occasionally blocks a legitimate query (for example PostgreSQL `E'...'` strings).
- Use a dedicated read-only database account. A superuser can do things a read-only transaction
  does not cover; the connection test warns about this.
- The host allowlist is checked at connect time, so DNS rebinding between check and connect is
  not fully closed.
