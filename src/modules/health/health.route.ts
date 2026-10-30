import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      service: 'lumen',
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/ready', async (_request, reply) => {
    try {
      await fastify.db.query('SELECT 1;');
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
