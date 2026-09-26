/**
 * Functions that read files, run code, change server/session state, take locks, sleep, or
 * open outbound connections. None has a legitimate use in a natural-language analytics
 * query, and each is reachable from a plain SELECT — which is why keyword blocking is not
 * enough. The list is applied to EVERY dialect (a function that doesn't exist in one engine
 * is harmless to block there).
 */
const EXACT = new Set<string>([
  // ---- PostgreSQL: server files / large objects ----
  'pg_read_file', 'pg_read_binary_file', 'pg_stat_file', 'pg_ls_dir', 'pg_ls_logdir', 'pg_ls_waldir',
  'pg_ls_tmpdir', 'pg_ls_archive_statusdir', 'pg_file_write', 'pg_file_rename', 'pg_file_unlink',
  'pg_logdir_ls', 'lo_import', 'lo_export', 'lo_create', 'lo_creat', 'lo_unlink', 'lo_put',
  'lo_from_bytea', 'lo_open', 'lo_close', 'lowrite', 'loread', 'lo_truncate',
  // ---- PostgreSQL: outbound connections / code execution ----
  'dblink', 'dblink_exec', 'dblink_connect', 'dblink_connect_u', 'dblink_send_query', 'dblink_open',
  'dblink_fetch', 'dblink_get_result',
  // ---- PostgreSQL: cancel/kill, sleep, locks, state changes ----
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
  'nextval', 'setval', 'set_config', 'pg_notify', 'pg_reload_conf', 'pg_rotate_logfile',
  'pg_switch_wal', 'pg_switch_xlog', 'pg_promote', 'pg_import_system_collations',
  'pg_extension_config_dump', 'pg_stat_reset', 'pg_stat_reset_shared', 'pg_stat_statements_reset',
  // ---- PostgreSQL: SQL-string executors ----
  'query_to_xml', 'query_to_xml_and_xmlschema', 'query_to_xmlschema', 'cursor_to_xml',
  'cursor_to_xmlschema',
  // ---- MySQL ----
  'load_file', 'sleep', 'benchmark', 'get_lock', 'release_lock', 'release_all_locks', 'is_free_lock',
  'is_used_lock', 'master_pos_wait', 'source_pos_wait', 'wait_for_executed_gtid_set',
  'wait_until_sql_thread_after_gtids', 'sys_exec', 'sys_eval', 'sys_get', 'sys_set',
  // ---- SQLite ----
  'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer', 'zeroblob', 'randomblob',
]);

/** Families of functions, matched by prefix on the (unqualified, lower-cased) name. */
const PREFIXES = [
  'pg_read_', 'pg_ls_', 'pg_file_', 'pg_sleep', 'pg_advisory', 'pg_try_advisory', 'pg_create_',
  'pg_drop_', 'pg_replication_', 'pg_logical_', 'pg_wal_', 'pg_backup_', 'pg_terminate_',
  'pg_cancel_', 'lo_', 'dblink', 'database_to_xml', 'schema_to_xml', 'table_to_xml', 'binary_upgrade_',
  'lib_mysqludf_',
];

/** `pg_catalog.pg_read_file` and `PG_READ_FILE` both normalise to `pg_read_file`. */
export function normalizeFunctionName(raw: unknown): string {
  let name: string;
  if (typeof raw === 'string') {
    name = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as { name?: unknown; value?: unknown };
    const parts = Array.isArray(obj.name)
      ? (obj.name as Array<{ value?: unknown }>).map((p) => String(p?.value ?? ''))
      : [String(obj.value ?? obj.name ?? '')];
    name = parts.join('.');
  } else {
    name = '';
  }
  const last = name.split('.').pop() ?? '';
  return last.replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
}

export function isDangerousFunction(normalizedName: string): boolean {
  if (!normalizedName) return false;
  if (EXACT.has(normalizedName)) return true;
  return PREFIXES.some((p) => normalizedName.startsWith(p));
}
