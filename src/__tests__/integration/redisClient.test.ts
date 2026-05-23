/**
 * redis client singleton tests.
 * Verifies env var handling and that warm invocations reuse the client.
 */

const mockConstructor = jest.fn();
const mockOn = jest.fn();
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((url: string, opts: any) => {
    mockConstructor(url, opts);
    return { on: mockOn };
  }),
}));

import { getRedisClient, _resetRedisClientForTests } from '../../redis/client';

describe('redis client singleton', () => {
  const originalUrl = process.env.REDIS_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetRedisClientForTests();
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterEach(() => {
    process.env.REDIS_URL = originalUrl;
  });

  test('throws when REDIS_URL is not set', () => {
    delete process.env.REDIS_URL;
    _resetRedisClientForTests();
    expect(() => getRedisClient()).toThrow('REDIS_URL env var is not set');
  });

  test('creates the client once and reuses on subsequent calls', () => {
    const a = getRedisClient();
    const b = getRedisClient();
    expect(a).toBe(b);
    expect(mockConstructor).toHaveBeenCalledTimes(1);
  });

  test('passes timeout + offline-queue tuning to ioredis', () => {
    getRedisClient();
    const [url, opts] = mockConstructor.mock.calls[0];
    expect(url).toBe('redis://localhost:6379');
    expect(opts.connectTimeout).toBe(3_000);
    expect(opts.maxRetriesPerRequest).toBe(1);
    expect(opts.enableOfflineQueue).toBe(false);
  });

  test('registers an error handler so transient errors do not crash Lambda', () => {
    getRedisClient();
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
