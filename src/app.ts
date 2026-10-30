import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import databasePlugin from './plugins/database.js';
import { healthRoutes } from './modules/health/health.route.js';

export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(opts);

  app.register(databasePlugin);
  app.register(healthRoutes);

  return app;
}

export default buildApp;
