import Fastify, { type FastifyInstance, type FastifyServerOptions, type FastifyError } from 'fastify';
import databasePlugin from './plugins/database.js';
import authenticatePlugin from './plugins/authenticate.js';
import { healthRoutes } from './modules/health/health.route.js';
import { mediaRoutes } from './modules/media/media.route.js';

export interface BuildAppOptions extends FastifyServerOptions {
  skipDatabase?: boolean;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const { skipDatabase, ...fastifyOpts } = opts;
  const app = Fastify(fastifyOpts);

  // Content type parser for raw binary streaming uploads.
  // Supports video/mp4 with media parameters (e.g. codecs, charset) and application/octet-stream.
  // Passing null streams directly to request.raw without buffering in memory.
  const rawStreamParser = (_req: any, _payload: any, done: (err: Error | null) => void) => {
    done(null);
  };

  app.addContentTypeParser(/^video\/mp4/i, rawStreamParser);
  app.addContentTypeParser('application/octet-stream', rawStreamParser);

  // Centralized error handler ensuring internal errors are sanitized
  // and appropriate client error codes are preserved.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || error.statusCode === 415) {
      return reply.status(415).send({
        error: 'unsupported_media_type',
        message: 'Content-Type must be video/mp4 or application/octet-stream',
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: 'validation_error',
        message: error.message,
      });
    }

    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: (error as any).error ?? 'client_error',
        message: error.message,
      });
    }

    request.log.error({ err: error }, 'Internal server error');
    return reply.status(500).send({
      error: 'internal_error',
      message: 'An internal error occurred',
    });
  });

  if (!skipDatabase) {
    app.register(databasePlugin);
    app.register(authenticatePlugin);
    app.register(mediaRoutes);
  }

  app.register(healthRoutes);

  return app;
}

export default buildApp;
