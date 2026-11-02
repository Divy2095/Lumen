import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { AuthService } from '../modules/auth/auth.service.js';
import type { AuthenticatedProject } from '../modules/auth/auth.types.js';

declare module 'fastify' {
  interface FastifyRequest {
    project?: AuthenticatedProject;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const authService = new AuthService(fastify.db);

  fastify.decorate(
    'authenticateApiKey',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const authHeader = request.headers.authorization;
      const xApiKey = request.headers['x-api-key'];

      let rawKey: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        rawKey = authHeader.slice(7).trim();
      } else if (typeof xApiKey === 'string') {
        rawKey = xApiKey.trim();
      }

      if (!rawKey) {
        return reply.status(401).send({
          error: 'unauthorized',
          message: 'Missing or invalid API key authorization header',
        });
      }

      const project = await authService.authenticateApiKey(rawKey);

      if (!project) {
        return reply.status(401).send({
          error: 'unauthorized',
          message: 'Invalid, expired, or revoked API key',
        });
      }

      if (project.status !== 'active') {
        return reply.status(403).send({
          error: 'project_inactive',
          message: 'Project is pending deletion or inactive',
        });
      }

      request.project = project;
    }
  );
};

export const authenticatePlugin = fp(authPlugin, {
  name: 'authenticate',
  dependencies: ['database'],
});

export default authenticatePlugin;
