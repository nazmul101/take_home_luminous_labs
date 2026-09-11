import express from 'express';
import * as authModule from './modules/auth/index';
import * as ordersModule from './modules/orders/index';
import { errorHandler } from './middlewares/error-handler.middle';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  // Unauthenticated on purpose: a readiness probe that needs a token is a probe that
  // fails for the wrong reason.
  app.get('/health', (_req, res) => {
    res.json({ success: true, message: 'ok', data: { status: 'healthy' } });
  });

  // Each module decides where it mounts.
  authModule.init(app);
  ordersModule.init(app);

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      message: 'Route not found',
      errors: [{ message: 'Route not found' }],
      code: 'not_found',
    });
  });

  // LAST, after every route. Express matches middleware in registration order and
  // identifies error handlers by their four-parameter arity - mounted before the
  // routes, this silently never runs.
  app.use(errorHandler);

  return app;
}
