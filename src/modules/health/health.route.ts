import type { FastifyPluginAsync } from 'fastify';
import type { QueryConfig } from 'pg';

interface BoundedQueryConfig extends QueryConfig {
  query_timeout?: number;
}

const READINESS_QUERY: BoundedQueryConfig = {
  text: 'SELECT 1;',
  query_timeout: 2000,
};

const NO_CACHE_HEADER = 'no-store, no-cache, must-revalidate, proxy-revalidate';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (_request, reply) => {
    reply.header('Cache-Control', NO_CACHE_HEADER);
    return {
      status: 'ok',
      service: 'lumen',
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/ready', async (_request, reply) => {
    reply.header('Cache-Control', NO_CACHE_HEADER);
    try {
      await fastify.db.query(READINESS_QUERY);
      return {
        status: 'ready',
        service: 'lumen',
        checks: {
          database: 'ok',
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      fastify.log.error(err, 'Database readiness check failed');
      return reply.status(503).send({
        status: 'not_ready',
        service: 'lumen',
        checks: {
          database: 'error',
        },
        timestamp: new Date().toISOString(),
      });
    }
  });
};

export default healthRoutes;
