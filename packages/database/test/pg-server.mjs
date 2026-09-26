// Starts a throwaway PostgreSQL (embedded-postgres is ESM-only, so it runs in its own process).
// Usage: node pg-server.mjs <port> <dataDir>; prints READY when accepting connections; stops on stdin close.
import EmbeddedPostgres from 'embedded-postgres';

const [port, dir] = [Number(process.argv[2]), process.argv[3]];
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'pw',
  port,
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => undefined,
  onError: () => undefined,
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
};
process.stdin.on('close', stop);
process.stdin.on('end', stop);
process.on('SIGTERM', stop);

await pg.initialise();
await pg.start();
console.log('READY');
process.stdin.resume();
