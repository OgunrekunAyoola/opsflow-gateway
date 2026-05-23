import crypto from 'crypto';
import { IGatewayChannelAdapter } from './IGatewayChannelAdapter';
import { NormalisedMessage } from '../types/NormalisedMessage';

/**
 * WhatsApp Cloud API channel adapter.
 *
 * Responsibilities (pure functions only — no Redis, no fetch, no logging here):
 *  - verifyWebhook: HMAC-SHA256 against Meta App Secret (X-Hub-Signature-256)
 *  - verifyChallenge: respond to Meta GET subscription challenges
 *  - normalise: parse the nested Meta payload into NormalisedMessage[]
 *
 * Status/delivery/read receipts are filtered out — they never reach Core.
 */
export class WhatsAppAdapter implements IGatewayChannelAdapter {
  readonly channel = 'whatsapp' as const;

  /**
   * Verify Meta's `X-Hub-Signature-256` header.
   * Value format: "sha256=<hex>". We HMAC the raw body with the App Secret
   * and compare in constant time.
   *
   * Returns false (never throws) on malformed input — the handler logs and
   * returns 200 OK regardless.
   */
  verifyWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {
    if (!signature || !secret) return false;
    if (!signature.startsWith('sha256=')) return false;

    const expectedHex = signature.slice('sha256='.length);
    let expected: Buffer;
    try {
      expected = Buffer.from(expectedHex, 'hex');
    } catch {
      return false;
    }
    if (expected.length !== 32) return false;

    const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    if (computed.length !== expected.length) return false;

    return crypto.timingSafeEqual(computed, expected);
  }

  /**
   * Validate a Meta webhook-subscription GET challenge.
   *
   * Meta sends: ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<random>
   * If `mode` is "subscribe" and `token` matches the per-tenant
   * `webhookVerifyToken` (resolved by the handler from Redis), returns
   * the challenge string for echo. Otherwise returns null.
   */
  verifyChallenge(params: {
    mode?: string;
    token?: string;
    challenge?: string;
    expectedToken: string;
  }): string | null {
    const { mode, token, challenge, expectedToken } = params;
    if (mode !== 'subscribe') return null;
    if (!token || !expectedToken || !challenge) return null;

    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expectedToken, 'utf8');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    return challenge;
  }

  /**
   * Convert a Meta WhatsApp Cloud webhook payload into NormalisedMessage[].
   * One webhook can contain multiple messages (Meta batches).
   *
   * Filters out: status updates, errors, and unknown message types.
   * Keeps:       text, image, video, audio, document, sticker, location, reaction.
   *              (We extract a best-effort body and leave media references for
   *              Core to resolve. The gateway never calls Meta to fetch a URL.)
   */
  normalise(payload: unknown, tenantId: string): NormalisedMessage[] {
    if (!isObject(payload)) return [];

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    const out: NormalisedMessage[] = [];

    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const changes = Array.isArray(entry.changes) ? entry.changes : [];

      for (const change of changes) {
        if (!isObject(change)) continue;
        if (change.field !== 'messages') continue;

        const value = change.value;
        if (!isObject(value)) continue;

        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const msg of messages) {
          const normalised = this.normaliseOne(msg, tenantId);
          if (normalised) out.push(normalised);
        }
      }
    }

    return out;
  }

  private normaliseOne(raw: unknown, tenantId: string): NormalisedMessage | null {
    if (!isObject(raw)) return null;

    const externalId = typeof raw.id === 'string' ? raw.id : null;
    const from = typeof raw.from === 'string' ? raw.from : null;
    const tsRaw = raw.timestamp;
    if (!externalId || !from || typeof tsRaw === 'undefined') return null;

    // Meta sends epoch seconds as either string or number. Both are valid.
    const epochSec = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw);
    if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
    const timestamp = new Date(epochSec * 1000).toISOString();

    const type = typeof raw.type === 'string' ? raw.type : 'unknown';
    let body = '';
    const mediaUrls: string[] = [];

    switch (type) {
      case 'text': {
        const text = isObject(raw.text) ? raw.text.body : undefined;
        if (typeof text === 'string') body = text;
        break;
      }
      case 'image':
      case 'video':
      case 'audio':
      case 'document':
      case 'sticker': {
        const media = isObject(raw[type]) ? raw[type] : undefined;
        if (media && typeof media.caption === 'string') body = media.caption;
        // No URLs to push — Meta returns a media id that requires an authed
        // call to resolve, which is Core's responsibility, not the gateway's.
        break;
      }
      case 'location': {
        const loc = isObject(raw.location) ? raw.location : undefined;
        if (loc) {
          const name = typeof loc.name === 'string' ? loc.name : '';
          const addr = typeof loc.address === 'string' ? loc.address : '';
          body = [name, addr].filter(Boolean).join(' — ') || '[location shared]';
        }
        break;
      }
      case 'reaction': {
        const r = isObject(raw.reaction) ? raw.reaction : undefined;
        const emoji = r && typeof r.emoji === 'string' ? r.emoji : '';
        body = emoji ? `[reaction: ${emoji}]` : '[reaction]';
        break;
      }
      default:
        // Unknown / unsupported types: still emit so Core can decide how to
        // handle. body stays empty; Core sees the externalId for dedup.
        body = '';
    }

    return {
      tenantId,
      channel: 'whatsapp',
      from,
      body,
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      externalId,
      timestamp,
    };
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
