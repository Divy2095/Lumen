import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import databasePlugin from './plugins/database.js';
import { healthRoutes } from './modules/health/health.route.js';

export interface BuildAppOptions extends FastifyServerOptions {
  skipDatabase?: boolean;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const { skipDatabase, ...fastifyOpts } = opts;
  const app = Fastify(fastifyOpts);

  if (!skipDatabase) {
    app.register(databasePlugin);
  }
  app.register(healthRoutes);

  return app;
}

export default buildApp;
