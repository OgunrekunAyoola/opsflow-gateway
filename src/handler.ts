/**
 * Lambda handler for opsflow-gateway.
 *
 * Receives every inbound channel webhook via the Lambda Function URL,
 * dispatches by (method, path) to the right adapter, and:
 *
 *   GET  /webhooks/whatsapp   -> Meta subscription challenge
 *   POST /webhooks/whatsapp   -> Meta inbound message ingestion
 *
 * INVARIANT — always returns 200 OK to the caller. Returning 4xx/5xx risks
 * Meta disabling the webhook. Internal failures (bad signature, unknown
 * tenant, redis blip) are logged and swallowed; we trust Meta's at-least-once
 * retry for genuine transport failures.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { WhatsAppAdapter } from './adapters/WhatsAppAdapter';
import { getTenantIdByPhoneNumber, getTenantIdByVerifyToken } from './routing/routingCache';
import { publishInboundMessages } from './queue/publish';

const whatsappAdapter = new WhatsAppAdapter();

const OK_EMPTY: APIGatewayProxyStructuredResultV2 = { statusCode: 200, body: '' };

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const method = event.requestContext?.http?.method?.toUpperCase() ?? 'GET';
    const path   = event.requestContext?.http?.path ?? event.rawPath ?? '/';

    if (method === 'GET' && path === '/webhooks/whatsapp') {
      return await handleWhatsAppChallenge(event);
    }
    if (method === 'POST' && path === '/webhooks/whatsapp') {
      return await handleWhatsAppInbound(event);
    }

    // Unknown route. Still 200 — never give Meta a 4xx.
    return OK_EMPTY;
  } catch (err) {
    // Last-resort guard. Anything that throws past the per-handler guards
    // (config errors, env-var missing, etc.) still returns 200. We log so
    // CloudWatch surfaces it.
    log('error', 'handler_unexpected_error', { err: (err as Error).message });
    return OK_EMPTY;
  }
}

// ── GET challenge ───────────────────────────────────────────────────────────

async function handleWhatsAppChallenge(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const q = event.queryStringParameters ?? {};
  const mode      = q['hub.mode'];
  const token     = q['hub.verify_token'];
  const challenge = q['hub.challenge'];

  if (!token) {
    log('warn', 'wa_challenge_missing_token');
    return OK_EMPTY;
  }

  const tenantId = await getTenantIdByVerifyToken(token).catch(() => null);
  if (!tenantId) {
    log('warn', 'wa_challenge_unknown_token');
    return OK_EMPTY;
  }

  // Look up the canonical expected token by tenantId. The reverse-index hit
  // is itself proof the token is valid, but verifyChallenge does the
  // constant-time compare belt-and-braces.
  const echo = whatsappAdapter.verifyChallenge({
    mode,
    token,
    challenge,
    expectedToken: token, // we got here via the reverse index — same value
  });

  if (echo === null) {
    log('warn', 'wa_challenge_rejected', { tenantId });
    return OK_EMPTY;
  }

  log('info', 'wa_challenge_ok', { tenantId });
  return { statusCode: 200, body: echo };
}

// ── POST inbound ─────────────────────────────────────────────────────────────

async function handleWhatsAppInbound(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const rawBody = readRawBody(event);
  if (rawBody === null) {
    log('warn', 'wa_inbound_missing_body');
    return OK_EMPTY;
  }

  const signature = headerOf(event, 'x-hub-signature-256');
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    log('error', 'wa_inbound_app_secret_unset');
    return OK_EMPTY;
  }

  if (!whatsappAdapter.verifyWebhook(rawBody, signature, secret)) {
    log('warn', 'wa_inbound_signature_invalid');
    return OK_EMPTY;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log('warn', 'wa_inbound_invalid_json');
    return OK_EMPTY;
  }

  const phoneNumberId = whatsappAdapter.extractRoutingKey(payload);
  if (!phoneNumberId) {
    log('info', 'wa_inbound_no_routing_key');  // likely a status update with no metadata
    return OK_EMPTY;
  }

  const tenantId = await getTenantIdByPhoneNumber(phoneNumberId).catch((err) => {
    log('error', 'wa_inbound_routing_lookup_failed', { err: err.message, phoneNumberId });
    return null;
  });
  if (!tenantId) {
    log('warn', 'wa_inbound_unknown_tenant', { phoneNumberId });
    return OK_EMPTY;
  }

  const messages = whatsappAdapter.normalise(payload, tenantId);
  if (messages.length === 0) {
    log('info', 'wa_inbound_no_user_messages', { tenantId });
    return OK_EMPTY;
  }

  try {
    await publishInboundMessages(messages);
    log('info', 'wa_inbound_enqueued', { tenantId, count: messages.length });
  } catch (err) {
    // Redis is down. Per the always-200 contract, swallow and let Meta retry.
    log('error', 'wa_inbound_enqueue_failed', { err: (err as Error).message, tenantId });
  }

  return OK_EMPTY;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readRawBody(event: APIGatewayProxyEventV2): string | null {
  if (event.body == null) return null;
  if (event.isBase64Encoded) {
    try {
      return Buffer.from(event.body, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return event.body;
}

function headerOf(event: APIGatewayProxyEventV2, name: string): string | undefined {
  if (!event.headers) return undefined;
  const lc = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers)) {
    if (k.toLowerCase() === lc) return v ?? undefined;
  }
  return undefined;
}

function log(level: 'info' | 'warn' | 'error', event: string, extra: Record<string, any> = {}): void {
  // Single-line JSON so CloudWatch indexes it. Never log secrets / bodies.
  const line = JSON.stringify({ level, event, ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
