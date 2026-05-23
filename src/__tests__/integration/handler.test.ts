/**
 * Lambda handler integration tests.
 * Verifies routing, signature handling, tenant resolution, queue publish,
 * and the always-200 contract. Routing cache + queue publish are mocked;
 * the real adapter is used so HMAC + normalise behavior is exercised end-to-end.
 */

import crypto from 'crypto';

const mockGetTenantIdByPhoneNumber = jest.fn();
const mockGetTenantIdByVerifyToken = jest.fn();
jest.mock('../../routing/routingCache', () => ({
  getTenantIdByPhoneNumber: (...a: any[]) => mockGetTenantIdByPhoneNumber(...a),
  getTenantIdByVerifyToken: (...a: any[]) => mockGetTenantIdByVerifyToken(...a),
}));

const mockPublishInboundMessages = jest.fn().mockResolvedValue(undefined);
jest.mock('../../queue/publish', () => ({
  publishInboundMessages: (...a: any[]) => mockPublishInboundMessages(...a),
  publishInboundMessage: jest.fn(),
}));

import { handler } from '../../handler';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const APP_SECRET = 'meta-app-secret-test';
const originalSecret = process.env.WHATSAPP_APP_SECRET;

beforeAll(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
});
afterAll(() => {
  process.env.WHATSAPP_APP_SECRET = originalSecret;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPublishInboundMessages.mockResolvedValue(undefined);
});

function buildEvent(opts: {
  method: 'GET' | 'POST';
  path?:  string;
  query?: Record<string, string>;
  body?:  string;
  headers?: Record<string, string>;
  isBase64Encoded?: boolean;
}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: opts.path ?? '/webhooks/whatsapp',
    rawQueryString: '',
    headers: opts.headers ?? {},
    queryStringParameters: opts.query,
    requestContext: {
      accountId: '0',
      apiId: 'api',
      domainName: 'x',
      domainPrefix: 'x',
      http: {
        method: opts.method,
        path: opts.path ?? '/webhooks/whatsapp',
        protocol: 'HTTP/1.1',
        sourceIp: '0.0.0.0',
        userAgent: 'jest',
      },
      requestId: 'r',
      routeKey: '$default',
      stage: '$default',
      time: '23/May/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
    },
    body: opts.body,
    isBase64Encoded: opts.isBase64Encoded ?? false,
  };
}

function sign(body: string, secret = APP_SECRET): string {
  const mac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

const inboundBody = (overrides: any = {}) => JSON.stringify({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PHONE-1', display_phone_number: '+234' },
            messages: [
              { from: '2348012345678', id: 'wamid.ABC', timestamp: '1716372000', type: 'text', text: { body: 'hi' } },
            ],
            ...overrides,
          },
        },
      ],
    },
  ],
});

// ── GET /webhooks/whatsapp (challenge) ──────────────────────────────────────

describe('GET /webhooks/whatsapp — subscription challenge', () => {
  test('echoes the challenge when the verify token resolves to a tenant', async () => {
    mockGetTenantIdByVerifyToken.mockResolvedValueOnce('tenant-1');

    const res = await handler(buildEvent({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-abc', 'hub.challenge': 'CHALLENGE-XYZ' },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('CHALLENGE-XYZ');
    expect(mockGetTenantIdByVerifyToken).toHaveBeenCalledWith('verify-abc');
  });

  test('returns 200 empty when token is unknown', async () => {
    mockGetTenantIdByVerifyToken.mockResolvedValueOnce(null);

    const res = await handler(buildEvent({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'unknown', 'hub.challenge': 'X' },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  test('returns 200 empty when token query param is missing', async () => {
    const res = await handler(buildEvent({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.challenge': 'X' },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(mockGetTenantIdByVerifyToken).not.toHaveBeenCalled();
  });

  test('returns 200 empty when mode is not subscribe (even with valid token)', async () => {
    mockGetTenantIdByVerifyToken.mockResolvedValueOnce('tenant-1');

    const res = await handler(buildEvent({
      method: 'GET',
      query: { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'verify-abc', 'hub.challenge': 'X' },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  test('returns 200 empty when routing cache lookup throws (redis down)', async () => {
    mockGetTenantIdByVerifyToken.mockRejectedValueOnce(new Error('Redis down'));

    const res = await handler(buildEvent({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-abc', 'hub.challenge': 'X' },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});

// ── POST /webhooks/whatsapp (inbound) ───────────────────────────────────────

describe('POST /webhooks/whatsapp — inbound', () => {
  test('verifies HMAC, resolves tenant, normalises, enqueues', async () => {
    const body = inboundBody();
    mockGetTenantIdByPhoneNumber.mockResolvedValueOnce('tenant-1');

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockGetTenantIdByPhoneNumber).toHaveBeenCalledWith('PHONE-1');
    expect(mockPublishInboundMessages).toHaveBeenCalledTimes(1);
    const msgs = mockPublishInboundMessages.mock.calls[0][0];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      tenantId:   'tenant-1',
      channel:    'whatsapp',
      from:       '2348012345678',
      body:       'hi',
      externalId: 'wamid.ABC',
    });
  });

  test('lowercase signature header name still works', async () => {
    const body = inboundBody();
    mockGetTenantIdByPhoneNumber.mockResolvedValueOnce('tenant-1');

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPublishInboundMessages).toHaveBeenCalled();
  });

  test('handles base64-encoded body from Lambda Function URL', async () => {
    const body = inboundBody();
    const b64  = Buffer.from(body, 'utf8').toString('base64');
    mockGetTenantIdByPhoneNumber.mockResolvedValueOnce('tenant-1');

    const res = await handler(buildEvent({
      method: 'POST',
      body: b64,
      isBase64Encoded: true,
      // HMAC is computed against the DECODED body
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPublishInboundMessages).toHaveBeenCalled();
  });

  test('drops on invalid HMAC and never reaches routing or queue', async () => {
    const body = inboundBody();

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body, 'wrong-secret') },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(mockGetTenantIdByPhoneNumber).not.toHaveBeenCalled();
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });

  test('drops on missing signature header', async () => {
    const body = inboundBody();

    const res = await handler(buildEvent({ method: 'POST', body }));

    expect(res.statusCode).toBe(200);
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });

  test('drops when WHATSAPP_APP_SECRET is unset', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const body = inboundBody();

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': 'sha256=ignored' },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  });

  test('drops on invalid JSON body (verifies signature first, then fails parse)', async () => {
    const body = '{not json';

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockGetTenantIdByPhoneNumber).not.toHaveBeenCalled();
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });

  test('drops when phone_number_id is missing (e.g. status-update webhook)', async () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'X', status: 'delivered' }] } }] }],
    });

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockGetTenantIdByPhoneNumber).not.toHaveBeenCalled();
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });

  test('drops when tenant is unknown for the phone_number_id', async () => {
    const body = inboundBody();
    mockGetTenantIdByPhoneNumber.mockResolvedValueOnce(null);

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });

  test('skips publish when normalise yields zero messages (status-only webhook with metadata)', async () => {
    // metadata present, but only statuses[] — normalise filters them out
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PHONE-1' },
                statuses: [{ id: 'wamid.X', status: 'delivered', timestamp: '1716372000', recipient_id: '234' }],
              },
            },
          ],
        },
      ],
    });
    mockGetTenantIdByPhoneNumber.mockResolvedValueOnce('tenant-1');

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });

  test('returns 200 even when redis publish throws (always-200 contract)', async () => {
    const body = inboundBody();
    mockGetTenantIdByPhoneNumber.mockResolvedValueOnce('tenant-1');
    mockPublishInboundMessages.mockRejectedValueOnce(new Error('Redis down'));

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  test('returns 200 even when routing lookup throws (always-200 contract)', async () => {
    const body = inboundBody();
    mockGetTenantIdByPhoneNumber.mockRejectedValueOnce(new Error('Redis down'));

    const res = await handler(buildEvent({
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': sign(body) },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });
});

// ── Unknown routes ───────────────────────────────────────────────────────────

describe('unknown routes', () => {
  test.each([
    ['GET',  '/'],
    ['GET',  '/health'],
    ['POST', '/webhooks/email/postmark'],
    ['DELETE', '/webhooks/whatsapp'],
  ])('returns 200 empty for %s %s', async (method, path) => {
    const res = await handler(buildEvent({ method: method as any, path }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(mockPublishInboundMessages).not.toHaveBeenCalled();
  });
});
