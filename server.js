'use strict';
let config;
try {
  config = require('./src/config');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const { pool, migrate, bootstrapAdmin } = require('./src/db');
const { createApp } = require('./src/app');

async function main() {
  await migrate();
  await bootstrapAdmin();
  const server = createApp().listen(config.port, () => console.log(`GenePulse listening on port ${config.port}`));

  // Render sends SIGTERM on every deploy: finish in-flight requests, close the DB pool, then exit.
  const shutdown = (sig) => {
    console.log(`${sig} received - shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
