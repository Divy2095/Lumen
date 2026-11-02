import type { Pool } from 'pg';
import { hashSha256 } from '../../shared/crypto.js';
import type { AuthenticatedProject } from './auth.types.js';

export class AuthService {
  constructor(private db: Pool) {}

  /**
   * Authenticates a Bearer or API Key against api_keys and active projects.
   */
  async authenticateApiKey(rawKey: string): Promise<AuthenticatedProject | null> {
    if (!rawKey || typeof rawKey !== 'string') {
      return null;
    }

    const keyHash = hashSha256(rawKey);

    const query = `
      SELECT
        p.id AS project_id,
        p.account_id,
        p.name AS project_name,
        p.status AS project_status,
        k.id AS api_key_id
      FROM api_keys k
      INNER JOIN projects p ON p.id = k.project_id
      WHERE k.key_hash = $1
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > NOW())
      LIMIT 1;
    `;

    const result = await this.db.query<{
      project_id: string;
      account_id: string;
      project_name: string;
      project_status: string;
      api_key_id: string;
    }>(query, [keyHash]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    // Fire-and-forget throttled update of last_used_at (5 minute threshold)
    // Avoids updating the same api_keys row on every individual request.
    this.db.query(
      `UPDATE api_keys
       SET last_used_at = NOW()
       WHERE id = $1
         AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes');`,
      [row.api_key_id]
    ).catch(() => {});

    return {
      id: row.project_id,
      accountId: row.account_id,
      name: row.project_name,
      status: row.project_status,
      apiKeyId: row.api_key_id,
    };
  }
}
