import { createApp } from './app';
import { appConf } from './configs/app.config';
import { db } from './configs/db.config';

process.on('uncaughtException', (err: Error) => {
  console.error('[ERROR] Uncaught exception:', err.message);
  process.exit(1);
});

const server = createApp().listen(appConf.PORT, () => {
  console.log(`Server started at port ${appConf.PORT}`);
});

// Without this, `docker compose down` or a Ctrl-C kills in-flight requests mid-query
// and resets the pool's sockets rather than closing them.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
  });
}
