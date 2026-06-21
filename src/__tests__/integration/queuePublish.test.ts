/**
 * queue/publish integration tests.
 * Verifies LPUSH key, JSON shape, and pipeline batching.
 */

const mockLpush = jest.fn().mockResolvedValue(1);
const mockExec = jest.fn().mockResolvedValue([]);
const mockPipelineLpush = jest.fn();
const fakePipeline = {
  lpush: (...a: any[]) => {
    mockPipelineLpush(...a);
    return fakePipeline;
  },
  exec: (...a: any[]) => mockExec(...a),
};
jest.mock('../../redis/client', () => ({
  getRedisClient: () => ({
    lpush: (...a: any[]) => mockLpush(...a),
    pipeline: () => fakePipeline,
  }),
}));

import { publishInboundMessage, publishInboundMessages } from '../../queue/publish';
import { NormalisedMessage } from '../../types/NormalisedMessage';

const msg = (id: string): NormalisedMessage => ({
  tenantId: 'tenant-1',
  channel: 'whatsapp',
  from: '2348012345678',
  body: `body ${id}`,
  externalId: id,
  timestamp: '2026-05-23T10:00:00.000Z',
});

describe('publishInboundMessage', () => {
  beforeEach(() => jest.clearAllMocks());

  test('LPUSHes onto inbound-messages with JSON-encoded payload', async () => {
    await publishInboundMessage(msg('A'));
    expect(mockLpush).toHaveBeenCalledTimes(1);
    const [key, value] = mockLpush.mock.calls[0];
    expect(key).toBe('inbound-messages');
    expect(JSON.parse(value)).toEqual(msg('A'));
  });

  test('propagates redis errors so the handler can decide what to do', async () => {
    mockLpush.mockRejectedValueOnce(new Error('Redis down'));
    await expect(publishInboundMessage(msg('A'))).rejects.toThrow('Redis down');
  });
});

describe('publishInboundMessages (batch)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does nothing when array is empty', async () => {
    await publishInboundMessages([]);
    expect(mockPipelineLpush).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('LPUSHes every message in a single pipeline', async () => {
    await publishInboundMessages([msg('A'), msg('B'), msg('C')]);

    expect(mockPipelineLpush).toHaveBeenCalledTimes(3);
    expect(mockExec).toHaveBeenCalledTimes(1);

    for (const [key, value] of mockPipelineLpush.mock.calls) {
      expect(key).toBe('inbound-messages');
      expect(typeof value).toBe('string');
      const parsed = JSON.parse(value);
      expect(parsed.channel).toBe('whatsapp');
      expect(parsed.tenantId).toBe('tenant-1');
    }

    const ids = mockPipelineLpush.mock.calls.map(([, v]) => JSON.parse(v).externalId);
    expect(ids).toEqual(['A', 'B', 'C']);
  });
});
