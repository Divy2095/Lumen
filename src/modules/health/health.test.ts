import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

describe('Health & Readiness Endpoints', () => {
  describe('GET /health (Liveness)', () => {
    it('should return 200 with service status and cache control header without requiring database', async () => {
      const app = buildApp({ skipDatabase: true });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(
        response.headers['cache-control'],
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );

      const body = JSON.parse(response.payload);
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(body.service, 'lumen');
      assert.ok(typeof body.timestamp === 'string');
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)));

      await app.close();
    });
  });

  describe('GET /ready (Readiness - Mocked)', () => {
    it('should return 200 with checks.database: ok when database query succeeds', async () => {
      const app = buildApp({ skipDatabase: true });

      // Mock database pool that succeeds
      app.decorate('db', {
        query: async () => ({ rows: [{ '?column?': 1 }] }),
      } as unknown as FastifyInstance['db']);

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(
        response.headers['cache-control'],
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );

      const body = JSON.parse(response.payload);
      assert.strictEqual(body.status, 'ready');
      assert.strictEqual(body.service, 'lumen');
      assert.deepStrictEqual(body.checks, { database: 'ok' });
      assert.ok(typeof body.timestamp === 'string');
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)));

      await app.close();
    });

    it('should return 503 with checks.database: error when database query fails', async () => {
      const app = buildApp({ skipDatabase: true });

      // Mock database pool that throws a connection or query error
      app.decorate('db', {
        query: async () => {
          throw new Error('Connection terminated unexpectedly');
        },
      } as unknown as FastifyInstance['db']);

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      assert.strictEqual(response.statusCode, 503);
      assert.strictEqual(
        response.headers['cache-control'],
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );

      const body = JSON.parse(response.payload);
      assert.strictEqual(body.status, 'not_ready');
      assert.strictEqual(body.service, 'lumen');
      assert.deepStrictEqual(body.checks, { database: 'error' });
      assert.ok(typeof body.timestamp === 'string');
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)));

      await app.close();
    });
  });

  describe('GET /ready (Readiness - Live Database Integration)', () => {
    it('should connect to PostgreSQL and return 200 ready when database is available', async () => {
      // Skips if PGPASSWORD is not set in the environment
      if (!process.env.PGPASSWORD) {
        return;
      }

      const app = buildApp();
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.status, 'ready');
      assert.deepStrictEqual(body.checks, { database: 'ok' });

      await app.close();
    });
  });
});
