# Deploying opsflow-gateway

Production target: **AWS Lambda + Function URL**, deployed via **AWS SAM**.

## One-time prerequisites

1. **AWS account + CLI configured.** `aws sts get-caller-identity` should
   succeed. The principal needs permission to create Lambda functions, IAM
   roles, CloudFormation stacks, and S3 deployment buckets.
2. **AWS SAM CLI installed.** `sam --version` should report v1.x.
3. **Redis reachable from Lambda.** The same Redis instance opsflow-core uses.
   Most likely a managed instance (ElastiCache / Upstash / Redis Cloud) on a
   public endpoint protected by a strong password, or co-located in a VPC
   with the Lambda. If using a VPC-only Redis, you'll need to add a
   `VpcConfig` block to `template.yaml` and a NAT for outbound traffic — left
   out by default to keep cold starts fast.
4. **Meta App Secret.** Already provisioned when you created the WhatsApp
   Business Platform app. Same value across all tenants. **This is the App
   Secret, not per-tenant access tokens.**

## Build

```bash
npm install
npm run build      # esbuild bundles src/handler.ts to dist/handler.js
```

SAM packages `dist/` and `package.json` (plus `node_modules` for runtime
deps — currently just `ioredis`).

## First deploy (interactive)

```bash
sam deploy --guided \
  --parameter-overrides \
    RedisUrl="redis://USER:PASS@HOST:6379/0" \
    WhatsAppAppSecret="<from Meta App dashboard>" \
    Stage=prod
```

This writes deployment metadata into `samconfig.toml`. Subsequent deploys
can use:

```bash
npm run build
sam deploy --parameter-overrides \
  RedisUrl="..." WhatsAppAppSecret="..." Stage=prod
```

Both secrets are tagged `NoEcho` in CloudFormation and are not visible in
stack outputs.

## Post-deploy: wire up Meta

The stack output `GatewayUrl` is the public URL Meta calls. In the Meta App
dashboard → WhatsApp → Configuration:

| Field | Value |
|---|---|
| Callback URL | `<GatewayUrl>/webhooks/whatsapp` |
| Verify Token | Per tenant — provisioned by opsflow-core during onboarding (`POST /onboarding/whatsapp`) |
| Subscribed fields | `messages` (at minimum) |

When Meta sends its `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...`
challenge, the gateway looks up the token in Redis (populated by Core's
onboarding flow) and echoes back the challenge if it resolves to a known
tenant.

## Smoke-test the deployed function

```bash
# 1. Should return 200 with empty body (unknown verify token)
curl -i "$GatewayUrl/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bogus&hub.challenge=test"

# 2. Should return 200 with empty body (missing signature)
curl -i -X POST "$GatewayUrl/webhooks/whatsapp" -H "Content-Type: application/json" -d '{}'
```

Both should produce 200s. Check CloudWatch (`/aws/lambda/opsflow-gateway-prod`)
for the corresponding `wa_challenge_unknown_token` and `wa_inbound_missing_body`
log lines.

## Monitoring

The handler emits structured JSON to CloudWatch. Key event names to alert on:

| Event | Severity | What it means |
|---|---|---|
| `wa_inbound_enqueued` | info | Happy path — message handed to Core |
| `wa_inbound_signature_invalid` | warn | Bad HMAC. One-off = noise; a sustained burst means someone is probing |
| `wa_inbound_unknown_tenant` | warn | Webhook for a phoneNumberId not in the routing cache. Either onboarding didn't seed Redis or a tenant disconnected mid-flight |
| `wa_inbound_routing_lookup_failed` | error | Redis was unreachable during a routing lookup |
| `wa_inbound_enqueue_failed` | error | LPUSH failed. Messages dropped. Page on sustained occurrences |
| `wa_inbound_app_secret_unset` | error | `WHATSAPP_APP_SECRET` env var was missing — deploy is broken |
| `handler_unexpected_error` | error | Something threw past the per-handler guards. Investigate |

A reasonable starter alarm: `wa_inbound_enqueue_failed > 5 / 5min` pages
on-call. `wa_inbound_signature_invalid > 100 / 5min` notifies (probable
probing). Everything else is informational.

## Rollback

`sam rollback-config` returns the stack to the previous successful template
in CloudFormation. Lambda function versions are not used by default; add
`AutoPublishAlias: live` to the SAM resource if you want versioned rollbacks
at the Lambda layer too.

## Architecture decisions baked into `template.yaml`

- **arm64 (Graviton)** — ~20% cheaper, comparable cold-start for this
  workload. Switch to `x86_64` only if a native dep starts failing.
- **MemorySize: 256** — overprovisioned for this code, but Lambda CPU scales
  with memory; 256 MB cuts cold-start time meaningfully vs the default 128.
- **Timeout: 10s** — Meta's webhook timeout is ~20s. Ours is well under so
  we never trigger a Meta retry from our side; if we hit 10s something is
  badly wrong (Redis unreachable, JSON.parse blocked on a 10MB payload).
- **AuthType: NONE on the Function URL** — Meta cannot sign IAM-style
  requests. We authenticate every POST via HMAC inside the handler. The URL
  is intentionally world-reachable.
