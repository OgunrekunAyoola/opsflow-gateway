/**
 * NormalisedMessage — the ONLY contract between opsflow-gateway and opsflow-core.
 *
 * Every channel adapter outputs this shape. Core's `inboundMessage.worker.ts`
 * consumes this shape and nothing else. Raw vendor payloads never cross the
 * gateway/core boundary.
 *
 * Changes here are breaking across both repos — coordinate updates.
 */

export type ChannelKind = 'whatsapp' | 'email';

export interface NormalisedMessage {
  /** Resolved from the Redis routing cache populated by opsflow-core. */
  tenantId: string;

  /** Channel of origin. Extend the union when adding a new adapter. */
  channel: ChannelKind;

  /** Customer-side identifier — phone number (whatsapp) or email address. */
  from: string;

  /** Plaintext body. HTML-only emails are converted before this is set. May be empty for media-only messages. */
  body: string;

  /** Vendor CDN URLs. The gateway never downloads or proxies these. */
  mediaUrls?: string[];

  /**
   * Vendor-unique message id (Meta `messages[0].id`, RFC822 `Message-ID`, ...).
   * Used by Core as the dedup key in a 24h Redis SET.
   */
  externalId: string;

  /** ISO 8601 UTC timestamp. */
  timestamp: string;
}
