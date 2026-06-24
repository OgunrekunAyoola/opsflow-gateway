# opsflow-gateway — Claude Session Instructions

> Read at the start of every session. Update this file whenever a hard
> constraint changes or a new ADR lands.

---

## What this repo is

`opsflow-gateway` is the **inbound channel adapter host** for OpsFlow. It runs
on **AWS Lambda** (Function URL) and is the single ingress point for every
external channel webhook.

**Current scope: WhatsApp only.** The architecture supports additional channels
(Email, Instagram DMs, SMS, Slack, …) via the `IGatewayChannelAdapter`
interface, but only WhatsApp is implemented because that's where the target
vertical's traffic is. Adding a channel = one new adapter file + tests; no
gateway core changes needed.

Its only job is, per inbound request:

1. **Receive** the webhook (any external channel, any vendor).
2. **Verify** authenticity (HMAC, signing key, OAuth, whatever the vendor uses).
3. **Resolve tenant** from a Redis routing cache populated by `opsflow-core`.
4. **Normalise** the vendor-specific payload into a `NormalisedMessage`.
5. **Enqueue** it onto the Redis `inbound-messages` list.
6. **Return 200 OK** to the vendor — **always**, regardless of internal outcome.

That's it. There is no business logic here. No ticket model. No customer
identity. No threading. No AI. No tenant database. The gateway is intentionally
dumb — every decision beyond "is this signed and parseable" belongs in
`opsflow-core`.

---

## Why this exists (the architectural decision)

ADR-078 splits the OpsFlow runtime into two repos:

| Repo | Runtime | Owns |
|---|---|---|
| `opsflow-core` (Node, Railway/Render) | Long-lived workers + REST API | All business logic, AI pipeline, BullMQ workers, outbound sending, tenant DB |
| `opsflow-gateway` (this repo, AWS Lambda) | Cold-start function URL | Webhook ingress, signature verification, payload normalisation |

**The split is load-bearing for three reasons:**

1. **Reliability of ingress.** Meta and similar vendors disable webhooks that
   return non-2xx or time out. Running ingress on Lambda decouples webhook ACK
   latency from the health of long-running workers, the AI pipeline, or the
   tenant DB. Even if Core is fully down, the gateway still accepts and
   enqueues — Core catches up when it recovers.
2. **Blast radius.** Gateway code is tiny, audited, has no DB access, and
   carries no secrets beyond what Lambda's environment provides. A compromise
   here yields nothing.
3. **Cost shape.** Inbound bursts (e.g. a viral campaign reply storm) are
   absorbed by Lambda autoscaling, then processed by Core workers at their
   sustainable rate. No need to over-provision Core for peak.

**Long-term goal:** every new channel lands here as a new `IGatewayChannelAdapter`
implementation. Core never learns the vendor; it only consumes
`NormalisedMessage`. Likely future adapters in priority order: Instagram DMs,
Email (Postmark/SES), SMS (Twilio), Slack, Telegram — but none are in scope
right now.

---

## Hard Constraints — never violate these

### Zero business logic

The gateway does not:

- Look up customers
- Create tickets or threads
- Call any LLM
- Touch the tenant Mongo database
- Decide whether to escalate, route to human, or apply policy
- Hold any per-tenant state beyond the routing cache it reads from Redis

If you find yourself reaching for any of the above, **stop**. That logic
belongs in Core. The gateway's only outputs are: `200 OK` to the vendor, and
a JSON-encoded `NormalisedMessage` on the `inbound-messages` Redis list.

### Tokens never enter this repo

WhatsApp access tokens, OAuth refresh tokens, and similar per-tenant secrets
live **only** in `Tenant.whatsapp.accessToken` in opsflow-core's MongoDB,
encrypted with AES-256-GCM. They are decrypted only inside Core processes.

The gateway reads two things from Redis:
- `opsflow:wa_routing:phone:{phoneNumberId}` → `tenantId`
- `opsflow:wa_verify_token:{webhookVerifyToken}` → `tenantId`
- `opsflow:wa_verify:{tenantId}` → `webhookVerifyToken` (for challenge replies)

There is no third entry. If you need to call Meta from the gateway — don't.
That's an outbound concern and lives in Core.

### Gateway always returns 200 OK

This is non-negotiable for Meta and behaves the same for every channel we add.
Returning a 4xx or 5xx — even on signature failure, even on unknown tenant,
even on parse error — risks the vendor disabling the webhook. The gateway:

- Logs the failure with enough detail to investigate
- Increments a metric
- Returns `200 OK`

The only exception is genuine catastrophic failure (Lambda init crash) where
the runtime itself produces a 5xx. Code we control never does.

### Webhook signature verification is mandatory

Every adapter implements `verifyWebhook(rawBody, signatureHeader): boolean`
using a constant-time HMAC comparison (`crypto.timingSafeEqual`). The verify
secret is loaded from a Lambda environment variable provisioned per channel
(`WHATSAPP_APP_SECRET`, etc.). Signature failures log + drop + return 200.
**Never** skip verification, even temporarily, even "just for testing".

### Statelessness

The gateway holds no in-memory state between invocations beyond the Redis
client connection (lazy-initialised, reused across warm invocations). It does
not deduplicate messages — Core's `inbound-messages` worker handles dedup by
`externalId` in a 24h Redis SET. Trying to dedup here would either duplicate
that logic or under-protect Core on cold starts.

### Raw vendor payloads never leave the gateway

Core only ever sees `NormalisedMessage`. If a downstream feature in Core needs
something not currently in `NormalisedMessage`, **the field gets added to
`NormalisedMessage`**, normalised by each adapter, and consumed there. Core
never receives "the raw Meta payload" as a fallback. The whole point of the
split is that vendor shape changes are absorbed in one adapter, in one repo.

### Tests ship hand-in-hand

Same rule as opsflow-core's CLAUDE.md: every implementation lands with its
tests in the same commit. No exceptions. Tiers:

- **Unit**: pure functions (HMAC verify, normalise, challenge response). Zero
  mocks, zero I/O.
- **Integration**: components that touch external I/O (Redis routing cache,
  queue publish). All external I/O mocked via `jest.mock()`.

There are no flow tests here — the gateway is a Lambda handler; the closest
equivalent is an end-to-end test against a deployed Function URL, which lives
in `opsflow-core` as part of channel-integration suites (TBD).

---

## Contract: `NormalisedMessage`

This is the **only** thing Core sees. Every adapter outputs this shape:

```typescript
interface NormalisedMessage {
  tenantId:   string;       // resolved from Redis routing cache
  channel:    'whatsapp' | 'email';   // extend the union when adding a channel
  from:       string;       // phone number (whatsapp) or email address (email)
  body:       string;       // plain-text body — strip HTML before assigning
  mediaUrls?: string[];     // CDN URLs from the vendor; do not download
  externalId: string;       // Meta message id / RFC822 Message-ID — dedup key in Core
  timestamp:  string;       // ISO 8601, UTC
}
```

**Invariants:**
- `externalId` is whatever the vendor uses to uniquely identify the message
  (`messages[0].id` for Meta, `Message-Id` header for SMTP). It is the dedup
  key in Core. A normalisation that doesn't set this is a bug.
- `from` is the customer-side identifier. Tenant addresses never appear here.
- `body` is plaintext. HTML-only emails get converted (cheaply — no headless
  browser). Empty bodies are valid (e.g. media-only WhatsApp messages).
- `mediaUrls` are vendor CDN URLs. The gateway does not fetch or proxy them.
  Core decides what to do with them.

Adding a field is a coordinated change across both repos. Removing a field is
a breaking change to Core's `inboundMessage.worker.ts` and requires a migration.

---

## Folder layout

```
src/
  adapters/
    IGatewayChannelAdapter.ts   ← interface every channel implements
    WhatsAppAdapter.ts          ← Meta WhatsApp Cloud API
  routing/
    routingCache.ts             ← Redis reads (phoneNumberId, verifyToken lookups)
  queue/
    publish.ts                  ← rpush onto inbound-messages
  types/
    NormalisedMessage.ts        ← the contract
  __tests__/
    unit/                       ← pure normalise + verify tests
    integration/                ← Redis + queue mocked
  handler.ts                    ← Lambda entry — routes by path+method to adapter
```

**Placement rule:** if a file talks to Redis or builds a queue payload, it goes
in `routing/` or `queue/`. Adapters are pure (input → output) functions packaged
as classes — they never see Redis directly; the handler injects routing data.

---

## How the handler routes requests

The handler is dispatched by `(method, path)`:

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/webhooks/whatsapp` | Meta webhook subscription challenge |
| `POST` | `/webhooks/whatsapp` | Meta inbound message webhook |

Anything else returns `200 OK` with an empty body (still, never 4xx).

For each POST it:
1. Reads the raw body and the vendor signature header.
2. Verifies the signature via the adapter's `verifyWebhook(rawBody, signature)`.
3. On signature failure: log, return 200.
4. Resolves tenantId from the routing cache (Meta `phoneNumberId` → tenantId,
   or inbound recipient mailbox → tenantId).
5. On unknown tenant: log, return 200.
6. Normalises via `adapter.normalise(payload, tenantId)` — may yield multiple
   messages from one webhook (Meta batches).
7. `RPUSH inbound-messages <json>` for each.
8. Returns 200.

---

## Required environment variables

| Var | Purpose | Required |
|---|---|---|
| `REDIS_URL` | Connection URL for the shared Redis (same Redis as Core) | ✅ |
| `WHATSAPP_APP_SECRET` | Meta App Secret — used to HMAC-verify inbound webhooks | ✅ |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`. Default `info` | optional |
| `NODE_ENV` | `production` / `staging` / `dev` | optional |

**These are deploy-time Lambda env vars.** Never commit a `.env` file. Never
log the values. The `WHATSAPP_APP_SECRET` is a different secret from
per-tenant access tokens — it is the global Meta App secret and is the same
across every tenant.

---

## Phase B task list (current work)

Spec lives in `_private/CHANNEL_GATEWAY_ARCHITECTURE.md` in opsflow-core (not
checked in for privacy — ask the user if you need it).

| # | Task | Status |
|---|---|---|
| B1 | Repo setup: TypeScript, esbuild, ioredis, Lambda skeleton | ✅ 2026-05-23 |
| B2 | `NormalisedMessage` type + `IGatewayChannelAdapter` interface | ✅ 2026-05-23 |
| B3 | `WhatsAppAdapter`: `verifyWebhook()`, `verifyChallenge()`, `normalise()` | ✅ 2026-05-23 |
| ~~B4~~ | ~~`EmailAdapter`~~ | ⛔ descoped 2026-05-23 — WhatsApp-only for current vertical |
| B5 | Redis routing cache reads (`routing/routingCache.ts`) | ✅ 2026-05-23 |
| B6 | Queue publish to `inbound-messages` (LPUSH; Core does RPOP for FIFO) | ✅ 2026-05-23 |
| B7 | Lambda handler — routes GET/POST `/webhooks/whatsapp`; always returns 200 | ✅ 2026-05-23 |
| B8 | Deploy: SAM template (`template.yaml`) + deploy docs (`docs/DEPLOY.md`); awaiting AWS credentials | 🟡 ready-to-deploy |

> **Email is intentionally not in scope.** The target vertical's inbound
> traffic is WhatsApp-dominated. Adding email later is one new adapter file
> (`src/adapters/EmailAdapter.ts`) + tests; nothing else changes. The
> `NormalisedMessage.channel` type union still includes `'email'` to keep
> that path frictionless when revisited.

---

## Companion repo — opsflow-core

Lives in the sibling directory `opsFlow-Agent-Desk` (same parent folder as this
repo). Its CLAUDE.md is the source of truth for OpsFlow as a product.
This repo's job is bounded by the rules above; everything else — tickets,
threads, agents, billing, escalation, the AI pipeline — is Core's job.

When changing the cross-repo contract (`NormalisedMessage`, Redis routing keys,
the queue name), you must update both repos in lockstep. The pairing:

| Concept | Defined in gateway | Consumed in core |
|---|---|---|
| `NormalisedMessage` | `src/types/NormalisedMessage.ts` | `backend/src/workers/inboundMessage.worker.ts` |
| Redis routing keys (`opsflow:wa_routing:phone:*`, `opsflow:wa_verify:*`, `opsflow:wa_verify_token:*`) | `src/routing/routingCache.ts` (read) | `backend/src/services/WhatsAppRoutingCacheService.ts` (write) |
| `inbound-messages` Redis list | `src/queue/publish.ts` (RPUSH) | `backend/src/workers/inboundMessage.worker.ts` (RPOP) |
| `WHATSAPP_APP_SECRET` env var | gateway reads it for HMAC verify | n/a (Core never sees Meta signatures) |
| Per-tenant `webhookVerifyToken` | gateway reads from Redis for challenge | Core writes during onboarding (`routes/onboarding.ts`) |

---

## Session protocol

**Before implementing anything:**
1. Read this whole file. Most "should I do X here?" answers are above.
2. If the change touches the cross-repo contract, open opsflow-core and check
   the matching file in the table above.
3. If you need information that should be in the `_private/CHANNEL_GATEWAY_ARCHITECTURE.md`
   doc, ask the user — that doc is not in either repo.

**Before ending a session:**
1. `npx tsc --noEmit` — must be zero errors.
2. `npx jest --passWithNoTests` — must be zero failures.
3. Update this file's Phase B table if a task was closed.
4. If the cross-repo contract changed, update opsflow-core's CLAUDE.md too.
