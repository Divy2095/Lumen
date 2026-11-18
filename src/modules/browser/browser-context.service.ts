import type { Pool } from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ClerkIdentityResolver } from '../auth/clerk-identity.service.js';
import type { VerifiedClerkIdentity } from '../auth/clerk.service.js';

export interface BrowserProject {
  id: string;
  name: string;
}

export type BrowserContextResult =
  | { project: BrowserProject }
  | { error: 'account_not_linked' | 'no_active_project' | 'project_selection_ambiguous' };

declare module 'fastify' {
  interface FastifyRequest {
    browserProject?: BrowserProject;
  }
}

const messages = {
  account_not_linked: 'No Lumen account is linked to this identity.',
  no_active_project: 'No active project is available.',
  project_selection_ambiguous: 'More than one active project is available.',
};

export function requireBrowserProject(context: BrowserContextService) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = await context.resolveProject(request.clerkIdentity!);
    if ('error' in result) {
      reply.status(result.error === 'project_selection_ambiguous' ? 409 : 403)
        .send({ error: result.error, message: messages[result.error] });
      return;
    }
    request.browserProject = result.project;
  };
}

export class BrowserContextService {
  private readonly identities: ClerkIdentityResolver;

  constructor(private readonly db: Pick<Pool, 'query'>) {
    this.identities = new ClerkIdentityResolver(db);
  }

  async resolveProject(identity: VerifiedClerkIdentity): Promise<BrowserContextResult> {
    const accountId = await this.identities.resolveAccountId(identity);
    if (accountId === null) return { error: 'account_not_linked' };

    const result = await this.db.query<BrowserProject>(
      "SELECT id, name FROM projects WHERE account_id = $1 AND status = 'active' LIMIT 2",
      [accountId]);
    if (result.rows.length === 0) return { error: 'no_active_project' };
    if (result.rows.length > 1) return { error: 'project_selection_ambiguous' };
    const project = result.rows[0]!;
    return { project: { id: project.id, name: project.name } };
  }
}
