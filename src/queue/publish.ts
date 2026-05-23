import { getRedisClient } from '../redis/client';
import { NormalisedMessage } from '../types/NormalisedMessage';

/**
 * `inbound-messages` is the Redis list opsflow-core's worker drains.
 *
 * Gateway publishes with LPUSH; Core consumes with RPOP. The pair gives FIFO
 * ordering — oldest message is the next one Core processes. Mixing this up
 * (e.g. RPUSH + RPOP) would silently flip ordering to LIFO; do not change one
 * side without changing the other.
 */
const QUEUE_KEY = 'inbound-messages';

/**
 * Push a single NormalisedMessage onto the inbound queue.
 *
 * Throws on Redis failure. The caller (handler) is responsible for catching
 * and downgrading to a 200 OK per the gateway's never-4xx policy.
 */
export async function publishInboundMessage(msg: NormalisedMessage): Promise<void> {
  const redis = getRedisClient();
  await redis.lpush(QUEUE_KEY, JSON.stringify(msg));
}

/**
 * Publish a batch atomically with a single pipeline. Used when one webhook
 * yields multiple NormalisedMessages (Meta batches up to ~50). A pipeline
 * cuts round-trips and reduces partial-failure surface.
 */
export async function publishInboundMessages(msgs: NormalisedMessage[]): Promise<void> {
  if (msgs.length === 0) return;
  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  for (const m of msgs) {
    pipeline.lpush(QUEUE_KEY, JSON.stringify(m));
  }
  await pipeline.exec();
}
