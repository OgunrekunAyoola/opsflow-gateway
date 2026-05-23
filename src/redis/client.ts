import Redis from 'ioredis';

/**
 * Singleton ioredis client.
 *
 * Lambda lifecycle:
 *  - First (cold) invocation: creates the client. ioredis lazy-connects on
 *    first command, so this is cheap.
 *  - Warm invocations: reuses the same client. The TCP connection is held
 *    open by the Lambda execution environment between invocations.
 *
 * We intentionally suppress 'error' events so that a transient Redis blip
 * does not crash the Lambda process (Node's default for unhandled 'error'
 * events on EventEmitters is to throw). Per-command errors still surface as
 * rejected promises and are handled at the call site.
 */
let _client: Redis | null = null;

export function getRedisClient(): Redis {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL env var is not set');

  _client = new Redis(url, {
    // ioredis defaults reconnect on its own; tune timeouts down so a dead
    // Redis fails fast instead of holding the Lambda hostage.
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  _client.on('error', () => {
    // Swallow transient errors; per-command rejections are still raised.
  });

  return _client;
}

/**
 * Test-only: drop the singleton so the next call rebuilds it.
 * Production code never calls this.
 */
export function _resetRedisClientForTests(): void {
  _client = null;
}
