import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRedisConfig,
  getRedisConnectionOptions,
} from './redis.js';

describe('Redis Configuration Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_DB;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1. should return safe default configuration when environment variables are absent', () => {
    const config = getRedisConfig();
    assert.strictEqual(config.host, '127.0.0.1');
    assert.strictEqual(config.port, 6379);
    assert.strictEqual(config.password, undefined);
    assert.strictEqual(config.db, undefined);
  });

  it('2. should parse custom host, port, password, and db correctly', () => {
    process.env.REDIS_HOST = '10.0.0.5';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret-redis-password';
    process.env.REDIS_DB = '2';

    const config = getRedisConfig();
    assert.strictEqual(config.host, '10.0.0.5');
    assert.strictEqual(config.port, 6380);
    assert.strictEqual(config.password, 'secret-redis-password');
    assert.strictEqual(config.db, 2);
  });

  it('3. should throw an error when REDIS_PORT is not a valid integer between 1 and 65535', () => {
    process.env.REDIS_PORT = 'not-a-port';
    assert.throws(
      () => getRedisConfig(),
      /REDIS_PORT must be an integer between 1 and 65535/
    );

    process.env.REDIS_PORT = '0';
    assert.throws(
      () => getRedisConfig(),
      /REDIS_PORT must be an integer between 1 and 65535/
    );

    process.env.REDIS_PORT = '70000';
    assert.throws(
      () => getRedisConfig(),
      /REDIS_PORT must be an integer between 1 and 65535/
    );
  });

  it('4. should throw an error when REDIS_DB is not a non-negative integer', () => {
    process.env.REDIS_DB = '-1';
    assert.throws(
      () => getRedisConfig(),
      /REDIS_DB must be a non-negative integer/
    );

    process.env.REDIS_DB = 'abc';
    assert.throws(
      () => getRedisConfig(),
      /REDIS_DB must be a non-negative integer/
    );
  });

  it('5. should enforce maxRetriesPerRequest: null and enableReadyCheck: false for BullMQ compatibility', () => {
    const options = getRedisConnectionOptions();
    assert.strictEqual((options as any).maxRetriesPerRequest, null);
    assert.strictEqual((options as any).enableReadyCheck, false);
    assert.strictEqual((options as any).host, '127.0.0.1');
    assert.strictEqual((options as any).port, 6379);
  });
});
