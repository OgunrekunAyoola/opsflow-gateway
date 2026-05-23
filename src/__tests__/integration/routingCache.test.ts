/**
 * routingCache integration tests.
 * Verifies key shape matches opsflow-core's writer and lookups return null
 * cleanly on cache miss.
 */

const mockGet = jest.fn();
jest.mock('../../redis/client', () => ({
  getRedisClient: () => ({ get: (...args: any[]) => mockGet(...args) }),
}));

import { getTenantIdByPhoneNumber, getTenantIdByVerifyToken } from '../../routing/routingCache';

describe('routingCache', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getTenantIdByPhoneNumber', () => {
    test('reads the opsflow:wa_routing:phone key', async () => {
      mockGet.mockResolvedValueOnce('tenant-1');
      const out = await getTenantIdByPhoneNumber('PHONE-123');
      expect(mockGet).toHaveBeenCalledWith('opsflow:wa_routing:phone:PHONE-123');
      expect(out).toBe('tenant-1');
    });

    test('returns null on cache miss', async () => {
      mockGet.mockResolvedValueOnce(null);
      expect(await getTenantIdByPhoneNumber('UNKNOWN')).toBeNull();
    });

    test('returns null for empty/missing phoneNumberId without hitting redis', async () => {
      expect(await getTenantIdByPhoneNumber('')).toBeNull();
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('getTenantIdByVerifyToken', () => {
    test('reads the opsflow:wa_verify_token reverse-index key', async () => {
      mockGet.mockResolvedValueOnce('tenant-77');
      const out = await getTenantIdByVerifyToken('verify-abc');
      expect(mockGet).toHaveBeenCalledWith('opsflow:wa_verify_token:verify-abc');
      expect(out).toBe('tenant-77');
    });

    test('returns null on cache miss', async () => {
      mockGet.mockResolvedValueOnce(null);
      expect(await getTenantIdByVerifyToken('bad-token')).toBeNull();
    });

    test('returns null for empty token without hitting redis', async () => {
      expect(await getTenantIdByVerifyToken('')).toBeNull();
      expect(mockGet).not.toHaveBeenCalled();
    });
  });
});
