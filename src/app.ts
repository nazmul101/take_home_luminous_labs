import express from 'express';
import { authenticate } from './auth/middleware.js';
import { getUserOrders } from './orders/controller.js';
import { errorHandler } from './http/errors.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Unauthenticated on purpose: a readiness probe that needs a token is a probe
  // that fails for the wrong reason.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/users/:id/orders', authenticate, getUserOrders);

  // Last, and after the routes: Express selects error middleware by arity and by
  // registration order.
  app.use(errorHandler);

  return app;
}
