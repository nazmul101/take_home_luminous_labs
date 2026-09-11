import type { Express } from 'express';
import ordersRouter from './routes/orders.route';

export function init(app: Express): void {
  app.use('/api', ordersRouter);
}
