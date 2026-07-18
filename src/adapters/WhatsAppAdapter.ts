import crypto from 'crypto';
import { IGatewayChannelAdapter } from './IGatewayChannelAdapter';
import { NormalisedMessage } from '../types/NormalisedMessage';

/**
 * Coexistence webhook fields the gateway deliberately does not turn into messages in v1
 * (WHATSAPP_COEXISTENCE_PLAN.md §4 DEC-5c — history import is an NDPC decision, not a plumbing
 * one; app-state/contact sync has no core consumer yet). `detectDroppedFields` surfaces these so
 * the handler can log+meter the drop instead of it vanishing silently (must-be-visible).
 */
const DROPPED_COEXISTENCE_FIELDS = new Set(['history', 'smb_app_state_sync']);

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
   * Extract the Meta `phone_number_id` so the handler can resolve tenantId.
   * Scans entries until a `value.metadata.phone_number_id` is found — a
   * single webhook targets a single business phone number, so the first hit
   * is authoritative.
   */
  extractRoutingKey(payload: unknown): string | null {
    if (!isObject(payload)) return null;
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (!isObject(change)) continue;
        const value = change.value;
        if (!isObject(value)) continue;
        const meta = value.metadata;
        if (isObject(meta) && typeof meta.phone_number_id === 'string') {
          return meta.phone_number_id;
        }
      }
    }
    return null;
  }

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
   * Handles two change fields:
   *   - `messages`           → customer inbound (default `kind`, no `kind` field set)
   *   - `smb_message_echoes` → coexistence: the vendor's own WhatsApp Business app reply,
   *                            emitted as `kind:'vendor_echo'` keyed by the CUSTOMER (`to`).
   * Filters out: status updates, errors, and unknown message types. `history` /
   * `smb_app_state_sync` are dropped but surfaced via `detectDroppedFields()` (v1, §D2).
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
        const value = change.value;
        if (!isObject(value)) continue;

        if (change.field === 'messages') {
          const messages = Array.isArray(value.messages) ? value.messages : [];
          for (const msg of messages) {
            const normalised = this.normaliseOne(msg, tenantId);
            if (normalised) out.push(normalised);
          }
        } else if (change.field === 'smb_message_echoes') {
          // Coexistence (GA May 2025): the vendor sent this from their own WhatsApp Business app —
          // Meta mirrors it here so Core can persist it + stand the AI down (D3). `message_echoes[]`
          // items carry the SAME per-type shape as `messages[]` (text/image/.../reaction), just
          // `from`/`to` swapped: `from` is the vendor's own number, `to` is the customer.
          const echoes = Array.isArray(value.message_echoes) ? value.message_echoes : [];
          for (const msg of echoes) {
            const normalised = this.normaliseEchoOne(msg, tenantId);
            if (normalised) out.push(normalised);
          }
        }
        // Everything else (status receipts, and the deliberately-out-of-scope `history` /
        // `smb_app_state_sync`) is dropped here — see detectDroppedFields() for the latter two's
        // visibility.
      }
    }

    return out;
  }

  /**
   * Fields present in this payload that the gateway saw but did not turn into messages, limited to
   * the coexistence fields we consciously chose not to handle in v1 (§4 DEC-5c). Pure + side-effect
   * free by design (this class never logs) — the Lambda handler decides how to surface it.
   */
  detectDroppedFields(payload: unknown): string[] {
    if (!isObject(payload)) return [];
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    const found = new Set<string>();

    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (!isObject(change)) continue;
        if (typeof change.field === 'string' && DROPPED_COEXISTENCE_FIELDS.has(change.field)) {
          found.add(change.field);
        }
      }
    }

    return [...found];
  }

  private normaliseOne(raw: unknown, tenantId: string): NormalisedMessage | null {
    if (!isObject(raw)) return null;

    const externalId = typeof raw.id === 'string' ? raw.id : null;
    const from = typeof raw.from === 'string' ? raw.from : null;
    const tsRaw = raw.timestamp;
    if (!externalId || !from || typeof tsRaw === 'undefined') return null;

    const timestamp = parseEpochSeconds(tsRaw);
    if (!timestamp) return null;

    const { body, mediaUrls } = this.extractContent(raw);

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

  /**
   * Same field extraction as `normaliseOne`, but for a `message_echoes[]` item: the customer
   * address is `to` (the vendor sent it, so `from` is the vendor's own number — never the thread
   * key), and the result is tagged `kind: 'vendor_echo'` / `vendorAuthored: true` (D1).
   */
  private normaliseEchoOne(raw: unknown, tenantId: string): NormalisedMessage | null {
    if (!isObject(raw)) return null;

    const externalId = typeof raw.id === 'string' ? raw.id : null;
    const from = typeof raw.to === 'string' ? raw.to : null; // customer address — the thread key
    const tsRaw = raw.timestamp;
    if (!externalId || !from || typeof tsRaw === 'undefined') return null;

    const timestamp = parseEpochSeconds(tsRaw);
    if (!timestamp) return null;

    const { body, mediaUrls } = this.extractContent(raw);

    return {
      tenantId,
      channel: 'whatsapp',
      from,
      body,
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      externalId,
      timestamp,
      kind: 'vendor_echo',
      vendorAuthored: true,
    };
  }

  /** Per-type body/media extraction shared by customer messages and vendor echoes alike. */
  private extractContent(raw: Record<string, any>): { body: string; mediaUrls: string[] } {
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

    return { body, mediaUrls };
  }
}

/** Meta sends epoch seconds as either string or number. Returns null on anything non-finite/≤0. */
function parseEpochSeconds(tsRaw: unknown): string | null {
  const epochSec = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw);
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  return new Date(epochSec * 1000).toISOString();
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
