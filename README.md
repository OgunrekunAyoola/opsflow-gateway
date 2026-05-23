# opsflow-gateway

Inbound channel adapter host for [OpsFlow](https://github.com/OgunrekunAyoola/opsFlow-Agent-Desk).
Receives WhatsApp webhooks — verifies them, resolves the tenant, normalises
the payload, and enqueues it for the core backend to process. The
`IGatewayChannelAdapter` interface keeps the door open for additional channels
(email, SMS, etc.) when the product needs them.

Runs on **AWS Lambda** (Function URL).

## What it does

For every inbound vendor webhook:

1. Verify the vendor signature (HMAC).
2. Look up the tenant in a Redis routing cache populated by `opsflow-core`.
3. Convert the vendor-specific payload into a `NormalisedMessage`.
4. `RPUSH` it onto the `inbound-messages` Redis list.
5. Return `200 OK` to the vendor.

## What it doesn't do

- No tenant database access.
- No customer / ticket / thread logic.
- No LLM calls.
- No outbound sending.
- No per-tenant secrets — those stay in `opsflow-core`.

All business logic lives in `opsflow-core`. This repo is intentionally tiny
and dumb so that:
- Webhook acknowledgements stay fast and unaffected by Core's load.
- A compromise here yields nothing useful.
- New channels can land as a single adapter file without touching Core.

## Architecture

```
   Vendor webhook (Meta, Postmark, ...)
                │
                ▼
        ┌───────────────────────┐
        │  AWS Lambda (this)    │   ──── reads ────►  Redis routing cache
        │  - verify HMAC        │                     (written by opsflow-core)
        │  - resolve tenant     │
        │  - normalise          │
        └───────────────┬───────┘
                        │ RPUSH NormalisedMessage
                        ▼
                Redis: inbound-messages
                        │ RPOP
                        ▼
              opsflow-core (Railway/Render)
              - dedup (24h Redis SET)
              - identity resolution
              - thread / ticket ingestion
              - AI pipeline (LangGraph)
```

See [CLAUDE.md](./CLAUDE.md) for the full operating contract — what this repo
must and must not do, the cross-repo data contract, and the Phase B task list.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # jest
npm run build         # esbuild → dist/handler.js
npm run lint          # eslint
```

### Required environment variables (Lambda)

| Var | Purpose |
|---|---|
| `REDIS_URL` | Same Redis instance as `opsflow-core` |
| `WHATSAPP_APP_SECRET` | Meta App Secret for HMAC webhook verification |
| `LOG_LEVEL` | optional — `debug` / `info` / `warn` / `error` (default `info`) |

Never commit `.env` files. Secrets are provisioned at deploy time.

## Status

| Phase | Status |
|---|---|
| B1 — Repo skeleton | ✅ |
| B2 — Contract types | ✅ |
| B3 — WhatsApp adapter (verify + normalise) | ✅ |
| ~~B4 — Email adapter~~ | ⛔ descoped (WhatsApp-only vertical for now) |
| B5 — Redis routing cache reads | ⬜ |
| B6 — Queue publish | ⬜ |
| B7 — Lambda handler | ⬜ |
| B8 — AWS deploy | ⬜ |

## License

Private — not for distribution.
