import { getRedisClient } from '../redis/client';

/**
 * Read-side of the WhatsApp routing cache.
 *
 * Keys must match exactly what opsflow-core's WhatsAppRoutingCacheService
 * writes. Any change here is a cross-repo coordination — update the table
 * in CLAUDE.md and the matching file in Core in lockstep.
 */

const PHONE_KEY = (phoneNumberId: string) => `opsflow:wa_routing:phone:${phoneNumberId}`;
const VERIFY_TOKEN_REVERSE_KEY = (token: string) => `opsflow:wa_verify_token:${token}`;

/**
 * Resolve a Meta `phone_number_id` to its tenantId.
 * Returns null when the cache misses (unknown tenant / expired entry).
 * Callers must treat null as "drop the message, log, return 200".
 */
export async function getTenantIdByPhoneNumber(phoneNumberId: string): Promise<string | null> {
  if (!phoneNumberId) return null;
  const redis = getRedisClient();
  return redis.get(PHONE_KEY(phoneNumberId));
}

/**
 * Resolve a webhook verify token (sent by Meta during the GET subscription
 * challenge) to its tenantId. Used only on the GET challenge path; the POST
 * inbound path uses phoneNumberId routing.
 */
export async function getTenantIdByVerifyToken(verifyToken: string): Promise<string | null> {
  if (!verifyToken) return null;
  const redis = getRedisClient();
  return redis.get(VERIFY_TOKEN_REVERSE_KEY(verifyToken));
}
