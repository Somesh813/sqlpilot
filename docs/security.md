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
2. **Parse** — `node-sql-parser` builds an AST for the connection's dialect. On parse failure
   the validator falls back to a keyword classifier and raises the risk level.
3. **Validation & policy** (`validateSql`):
   - String literals and comments are stripped before any keyword scan.
   - **Always blocked:** `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, `RENAME`,
     `ATTACH`, `DETACH`, `VACUUM`, `REINDEX`, `CALL`, `EXEC(UTE)`, `PREPARE`, `DEALLOCATE`.
   - **Blocked unless write mode is on:** `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `MERGE`, `UPSERT`.
     Write mode requires `connection.writeEnabled` (ADMIN) **and** `ALLOW_WRITE_QUERIES=true`.
   - **Rejected:** multiple/stacked statements, `INTO OUTFILE` / `DUMPFILE`, `FOR UPDATE` / `FOR SHARE`.
   - A `LIMIT <QUERY_MAX_ROWS>` is appended to limit-less `SELECT`s (`normalizedSql`).
   - Returns `{ valid, statementKind, risk, referencedTables, violations, normalizedSql }`.
4. **User confirmation** — the API requires `confirmed: true` on `/queries/execute`; the UI
   shows the (possibly edited) SQL and the validation verdict first.
5. **Execution** — per-driver: statement timeout, read-only transaction where supported,
   hard row cap, pagination. Execution time and row count are recorded to `QueryHistory`
   and `AuditLog`.

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
- The SQL policy is deny-by-default but dialect coverage of `node-sql-parser` is not total;
  the keyword fallback + `LIMIT` wrapper are the backstop. Phase 10 adds a fuzzing pass.
