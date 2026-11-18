import type { FastifyPluginAsync } from 'fastify';
import { BrowserContextService, requireBrowserProject } from './browser-context.service.js';

export const browserProjectRoutes: FastifyPluginAsync = async (fastify) => {
  const context = new BrowserContextService(fastify.db);

  fastify.get('/v1/browser/project', {
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'no-store'); },
    preHandler: [fastify.authenticateClerk, requireBrowserProject(context)],
  }, async (request, reply) => {
    return reply.send(request.browserProject!);
  });
};
