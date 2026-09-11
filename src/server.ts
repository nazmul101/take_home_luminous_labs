import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';

const server = createApp().listen(config.PORT, () => {
  console.log(`listening on http://localhost:${config.PORT}`);
});

// Without this, `docker compose down` or a Ctrl-C leaves in-flight requests to be
// killed mid-query and the pool's sockets to be reset rather than closed.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
  });
}
