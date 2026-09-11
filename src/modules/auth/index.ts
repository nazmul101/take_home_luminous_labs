import type { Express } from 'express';
import authRouter from './routes/auth.route';

/**
 * Each module owns where it mounts. app.ts calls init() and knows nothing about the
 * module's internal paths.
 */
export function init(app: Express): void {
  app.use('/api/auth', authRouter);
}
