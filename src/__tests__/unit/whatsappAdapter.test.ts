/**
 * WhatsAppAdapter unit tests.
 * Pure functions — no mocks, no I/O.
 */

import crypto from 'crypto';
import { WhatsAppAdapter } from '../../adapters/WhatsAppAdapter';

const SECRET = 'meta-app-secret-test';
const adapter = new WhatsAppAdapter();

function sign(body: string, secret = SECRET): string {
  const mac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

describe('WhatsAppAdapter.verifyWebhook', () => {
  const body = JSON.stringify({ entry: [] });

  test('accepts a correctly signed body', () => {
    expect(adapter.verifyWebhook(body, sign(body), SECRET)).toBe(true);
  });

  test('rejects when signature is missing', () => {
    expect(adapter.verifyWebhook(body, undefined, SECRET)).toBe(false);
    expect(adapter.verifyWebhook(body, '', SECRET)).toBe(false);
  });

  test('rejects when secret is empty', () => {
    expect(adapter.verifyWebhook(body, sign(body), '')).toBe(false);
  });

  test('rejects when prefix is wrong', () => {
    const mac = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(adapter.verifyWebhook(body, `sha1=${mac}`, SECRET)).toBe(false);
    expect(adapter.verifyWebhook(body, mac, SECRET)).toBe(false);
  });

  test('rejects when secret is different', () => {
    expect(adapter.verifyWebhook(body, sign(body, 'other-secret'), SECRET)).toBe(false);
  });

  test('rejects when body has been tampered with', () => {
    const sig = sign(body);
    expect(adapter.verifyWebhook(body + ' ', sig, SECRET)).toBe(false);
  });

  test('rejects malformed hex without throwing', () => {
    expect(adapter.verifyWebhook(body, 'sha256=not-hex-at-all-zzz', SECRET)).toBe(false);
  });

  test('rejects signatures of the wrong byte length', () => {
    // 16 bytes (32 hex chars) instead of 32 bytes (64 hex chars)
    expect(adapter.verifyWebhook(body, 'sha256=' + 'a'.repeat(32), SECRET)).toBe(false);
  });
});

describe('WhatsAppAdapter.verifyChallenge', () => {
  test('returns the challenge when mode=subscribe and token matches', () => {
    const out = adapter.verifyChallenge({
      mode: 'subscribe',
      token: 'verify-token-123',
      challenge: '987654321',
      expectedToken: 'verify-token-123',
    });
    expect(out).toBe('987654321');
  });

  test('returns null when token does not match', () => {
    const out = adapter.verifyChallenge({
      mode: 'subscribe',
      token: 'wrong-token',
      challenge: '987654321',
      expectedToken: 'verify-token-123',
    });
    expect(out).toBeNull();
  });

  test('returns null when mode is not subscribe', () => {
    expect(
      adapter.verifyChallenge({
        mode: 'unsubscribe',
        token: 'verify-token-123',
        challenge: '987654321',
        expectedToken: 'verify-token-123',
      }),
    ).toBeNull();
  });

  test('returns null when any required field is missing', () => {
    expect(adapter.verifyChallenge({ expectedToken: 'v' })).toBeNull();
    expect(adapter.verifyChallenge({ mode: 'subscribe', expectedToken: 'v' })).toBeNull();
    expect(adapter.verifyChallenge({ mode: 'subscribe', token: 'v', expectedToken: 'v' })).toBeNull();
  });

  test('returns null when expectedToken differs in length', () => {
    expect(
      adapter.verifyChallenge({
        mode: 'subscribe',
        token: 'short',
        challenge: 'c',
        expectedToken: 'a-much-longer-token',
      }),
    ).toBeNull();
  });
});

describe('WhatsAppAdapter.extractRoutingKey', () => {
  test('returns metadata.phone_number_id from the first entry', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: 'PHONE-1', display_phone_number: '+234' } },
            },
          ],
        },
      ],
    };
    expect(adapter.extractRoutingKey(payload)).toBe('PHONE-1');
  });

  test('returns first match across multiple entries', () => {
    const payload = {
      entry: [
        { changes: [{ field: 'messages', value: { metadata: {} } }] },
        { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PHONE-2' } } }] },
      ],
    };
    expect(adapter.extractRoutingKey(payload)).toBe('PHONE-2');
  });

  test('returns null when metadata is missing', () => {
    const payload = { entry: [{ changes: [{ field: 'messages', value: {} }] }] };
    expect(adapter.extractRoutingKey(payload)).toBeNull();
  });

  test('returns null for non-object payload', () => {
    expect(adapter.extractRoutingKey(null)).toBeNull();
    expect(adapter.extractRoutingKey('not json')).toBeNull();
    expect(adapter.extractRoutingKey([])).toBeNull();
  });

  test('returns null when entries are empty', () => {
    expect(adapter.extractRoutingKey({ entry: [] })).toBeNull();
  });
});

describe('WhatsAppAdapter.normalise', () => {
  const baseEnv = (messages: any[]) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages } }],
      },
    ],
  });

  test('returns empty array for non-object input', () => {
    expect(adapter.normalise(null, 'tenant-1')).toEqual([]);
    expect(adapter.normalise('not json', 'tenant-1')).toEqual([]);
    expect(adapter.normalise([], 'tenant-1')).toEqual([]);
  });

  test('returns empty array when there are no entries', () => {
    expect(adapter.normalise({}, 'tenant-1')).toEqual([]);
    expect(adapter.normalise({ entry: [] }, 'tenant-1')).toEqual([]);
  });

  test('normalises a single text message', () => {
    const out = adapter.normalise(
      baseEnv([
        {
          from: '2348012345678',
          id: 'wamid.ABC',
          timestamp: '1716372000',
          type: 'text',
          text: { body: 'Hello support' },
        },
      ]),
      'tenant-1',
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      tenantId: 'tenant-1',
      channel: 'whatsapp',
      from: '2348012345678',
      body: 'Hello support',
      mediaUrls: undefined,
      externalId: 'wamid.ABC',
      timestamp: new Date(1716372000 * 1000).toISOString(),
    });
  });

  test('handles epoch seconds as number too', () => {
    const out = adapter.normalise(
      baseEnv([{ from: '234', id: 'wamid.X', timestamp: 1716372000, type: 'text', text: { body: 'hi' } }]),
      'tenant-1',
    );

    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(new Date(1716372000 * 1000).toISOString());
  });

  test('extracts caption from media messages and leaves mediaUrls undefined', () => {
    const out = adapter.normalise(
      baseEnv([
        {
          from: '234',
          id: 'wamid.IMG',
          timestamp: '1716372000',
          type: 'image',
          image: { id: 'META-MEDIA-1', mime_type: 'image/jpeg', caption: 'Check this' },
        },
      ]),
      'tenant-1',
    );

    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('Check this');
    expect(out[0].mediaUrls).toBeUndefined();
  });

  test('keeps empty body for media without caption', () => {
    const out = adapter.normalise(
      baseEnv([{ from: '234', id: 'wamid.AUD', timestamp: '1716372000', type: 'audio', audio: { id: 'M' } }]),
      'tenant-1',
    );

    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('');
  });

  test('builds a body from location name and address', () => {
    const out = adapter.normalise(
      baseEnv([
        {
          from: '234',
          id: 'wamid.LOC',
          timestamp: '1716372000',
          type: 'location',
          location: { latitude: 6.5, longitude: 3.4, name: 'Lekki Office', address: '12 Admiralty Way' },
        },
      ]),
      'tenant-1',
    );

    expect(out[0].body).toBe('Lekki Office — 12 Admiralty Way');
  });

  test('falls back to placeholder for location without name/address', () => {
    const out = adapter.normalise(
      baseEnv([
        {
          from: '234',
          id: 'wamid.LOC2',
          timestamp: '1716372000',
          type: 'location',
          location: { latitude: 6.5, longitude: 3.4 },
        },
      ]),
      'tenant-1',
    );

    expect(out[0].body).toBe('[location shared]');
  });

  test('encodes reactions as [reaction: emoji]', () => {
    const out = adapter.normalise(
      baseEnv([
        {
          from: '234',
          id: 'wamid.R',
          timestamp: '1716372000',
          type: 'reaction',
          reaction: { message_id: 'wamid.ABC', emoji: '👍' },
        },
      ]),
      'tenant-1',
    );

    expect(out[0].body).toBe('[reaction: 👍]');
  });

  test('emits multiple messages from a single webhook (Meta batching)', () => {
    const out = adapter.normalise(
      baseEnv([
        { from: '234', id: 'wamid.A', timestamp: '1716372000', type: 'text', text: { body: 'one' } },
        { from: '234', id: 'wamid.B', timestamp: '1716372001', type: 'text', text: { body: 'two' } },
        { from: '234', id: 'wamid.C', timestamp: '1716372002', type: 'text', text: { body: 'three' } },
      ]),
      'tenant-1',
    );

    expect(out).toHaveLength(3);
    expect(out.map((m) => m.body)).toEqual(['one', 'two', 'three']);
  });

  test('emits across multiple entries and changes', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { from: '1', id: 'A', timestamp: '1716372000', type: 'text', text: { body: 'a' } },
                ],
              },
            },
          ],
        },
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { from: '2', id: 'B', timestamp: '1716372000', type: 'text', text: { body: 'b' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = adapter.normalise(payload, 'tenant-1');
    expect(out).toHaveLength(2);
  });

  test('ignores status updates (delivery / read receipts)', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  { id: 'wamid.ABC', status: 'delivered', timestamp: '1716372000', recipient_id: '234' },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(adapter.normalise(payload, 'tenant-1')).toEqual([]);
  });

  test('ignores changes with field other than "messages"', () => {
    const payload = {
      entry: [
        {
          changes: [{ field: 'account_alerts', value: { foo: 'bar' } }],
        },
      ],
    };
    expect(adapter.normalise(payload, 'tenant-1')).toEqual([]);
  });

  test('drops messages missing required fields (id / from / timestamp)', () => {
    const out = adapter.normalise(
      baseEnv([
        { id: 'wamid.X', timestamp: '1716372000', type: 'text', text: { body: 'no from' } },
        { from: '234', timestamp: '1716372000', type: 'text', text: { body: 'no id' } },
        { from: '234', id: 'wamid.Y', type: 'text', text: { body: 'no ts' } },
      ]),
      'tenant-1',
    );

    expect(out).toEqual([]);
  });

  test('drops messages with invalid timestamp', () => {
    const out = adapter.normalise(
      baseEnv([
        { from: '234', id: 'wamid.Z', timestamp: 'not-a-number', type: 'text', text: { body: 'x' } },
        { from: '234', id: 'wamid.W', timestamp: -1, type: 'text', text: { body: 'x' } },
      ]),
      'tenant-1',
    );

    expect(out).toEqual([]);
  });

  test('keeps unknown types but with empty body', () => {
    const out = adapter.normalise(
      baseEnv([
        {
          from: '234',
          id: 'wamid.U',
          timestamp: '1716372000',
          type: 'contacts',
          contacts: [{ name: { formatted_name: 'Z' } }],
        },
      ]),
      'tenant-1',
    );

    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('');
  });

  test('every emitted message carries the supplied tenantId', () => {
    const out = adapter.normalise(
      baseEnv([{ from: '234', id: 'wamid.A', timestamp: '1716372000', type: 'text', text: { body: 'a' } }]),
      'tenant-XYZ',
    );
    expect(out[0].tenantId).toBe('tenant-XYZ');
  });
});
