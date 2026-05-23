import { NormalisedMessage } from '../types/NormalisedMessage';

/**
 * Contract every channel adapter implements in opsflow-gateway.
 *
 * Implementations are PURE — given the raw request, they verify and normalise.
 * They never touch Redis, never call out to the vendor, never log secrets.
 * The Lambda handler is responsible for routing-cache lookups and queue pushes;
 * the adapter only produces the parsed result.
 */
export interface IGatewayChannelAdapter {
  /** Identifier used in metrics, logs, and `NormalisedMessage.channel`. */
  readonly channel: 'whatsapp' | 'email';

  /**
   * Constant-time HMAC verification of a webhook body.
   *
   * @param rawBody  The raw request body string as received (no JSON parse).
   * @param signature The vendor-supplied signature header value.
   * @param secret   The verifying secret (Meta App Secret, etc.) provisioned
   *                 via Lambda environment variables.
   * @returns true iff the signature matches.
   *
   * MUST use `crypto.timingSafeEqual` to avoid timing-attack leaks.
   * MUST NOT throw on malformed input — return false and let the handler
   * log and return 200.
   */
  verifyWebhook(rawBody: string, signature: string | undefined, secret: string): boolean;

  /**
   * Convert a verified vendor payload into one or more `NormalisedMessage`s.
   *
   * A single webhook may contain multiple messages (Meta batches up to ~50).
   * Implementations return one NormalisedMessage per inbound user message.
   * Status/delivery updates and other non-message events MUST be filtered out
   * here — they never reach Core.
   *
   * @param payload   The already-parsed JSON body of the webhook.
   * @param tenantId  The tenant the gateway resolved from the routing cache.
   * @returns An array (possibly empty) of NormalisedMessage objects.
   */
  normalise(payload: unknown, tenantId: string): NormalisedMessage[];
}
