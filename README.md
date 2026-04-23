# OmniList — Marketplace Aggregator Prototype

**Variant 2 · Senior Engineer Assignment** — a working marketplace aggregator deployed on AWS. List a product once, push it to a mocked eBay-style pipeline, and watch every webhook event flow back into a unified activity feed.

**Live URL:** `https://d2vr1psucpbtp2.cloudfront.net` *(deployed, publicly accessible)*

See [APPROACH.md](./APPROACH.md) for architecture decisions, eBay reference notes, safety model, and cost analysis.

---

## What it does

- **Create a listing** (title, description, price, optional image URL) or **snap a photo** and let Claude Haiku 4.5 fill the form via Amazon Bedrock
- **Bulk AI listing** — one photo of multiple items → Claude identifies each one → review and publish all in one click
- The listing is dispatched to a **mock eBay marketplace** (separate Lambda + FIFO SQS), which applies a ~15% synthetic failure rate to prove retries and idempotency work
- The mock posts two **signed webhooks** back: `new_comment` then `item_sold`
- A **webhook receiver** validates the HMAC-SHA256 signature and writes events to the aggregated activity feed
- A **live dashboard** shows all listings, their pipeline state (Submit → Live → Sold), activity timeline, and revenue stats

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | 20+ | `node -v` |
| AWS CLI v2 | latest | `aws --version` |
| AWS credentials configured | — | `aws sts get-caller-identity` |

**One-time CDK bootstrap** (per account + region):

```bash
npx aws-cdk@2 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-west-2
```

---

## Deploy (single command from a clean clone)

```bash
npm install --prefix infra && npm install --prefix frontend && npm run deploy
```

This builds the static site, compiles the CDK app, deploys all infrastructure, uploads to S3, and invalidates CloudFront. First deploy takes ~5–10 minutes (CloudFront distribution creation). Subsequent code-only updates take ~30–60 seconds.

### Stack outputs

After deploy, the terminal prints:

| Output | Description |
|--------|-------------|
| `CloudFrontURL` | Open this in any browser — the full app lives here |
| `HttpApiUrl` | Direct API Gateway URL for curl / smoke tests |
| `MockPublishFunctionUrl` | Mock marketplace ingress (called by the API Lambda) |
| `WebhookSecretArn` | Secrets Manager ARN for the HMAC signing key (never in git) |

---

## Tear down

```bash
npm run destroy
```

Runs `cdk destroy --all --force`. The S3 bucket uses `autoDeleteObjects: true` so no manual cleanup is needed. A single teardown leaves nothing running that will incur charges next month.

---

## Triggering mock events

The normal flow is fully automatic:

1. Create a listing in the UI
2. The API Lambda calls the mock accept endpoint → enqueued in FIFO SQS
3. The mock worker dequeues, waits 1.5–4s (simulating async partner latency), applies ~15% synthetic failure (SQS retries up to 6 times), then POSTs two signed webhooks:
   - `new_comment` — simulates a buyer asking "Is this still available?"
   - `item_sold` — marks the listing sold and closes the pipeline

**If a message fails all 6 retries** it lands in the DLQ. The UI shows a **Replay DLQ** button that re-enqueues failed messages — or call it directly:

```bash
curl -X POST https://YOUR_CLOUDFRONT_URL/api/admin/replay-dlq
```

---

## AI listing features

### Single item

1. Click the **✨ AI · 1 item** tab
2. Upload or take a photo (JPEG, PNG, WebP, AVIF, HEIC supported)
3. Click **Analyze with AI** — Claude Haiku 4.5 returns title, description, and a suggested price
4. Edit anything, then click **Publish listing**

### Bulk listing (multiple items from one photo)

1. Click the **🗂️ AI · Bulk** tab
2. Upload a photo containing multiple distinct items (works great for collections, card lots, shelf photos)
3. Click **Identify all items** — Claude identifies up to 10 separate items
4. Each item gets an editable card (title, price, description) with a checkbox
5. Uncheck any you don't want, edit as needed, then **Publish X listings**

**First-time Bedrock setup** (one-time per AWS account):
Go to [Amazon Bedrock → Model catalog](https://console.aws.amazon.com/bedrock/home#/model-catalog), find **Claude Haiku 4.5**, click **Open in playground** and accept Anthropic's terms. No separate Anthropic account needed — billing goes through AWS.

---

## Delete listings

- **Single delete**: hover a listing card → click the 🗑 button → confirm
- **Mass delete**: click **☑ Select** in the feed header → check multiple cards → **Delete selected** → confirm

---

## Smoke test (against deployed stack)

```bash
export API_URL="https://YOUR_API_ID.execute-api.us-west-2.amazonaws.com"
node scripts/smoke-test.mjs
```

Creates a listing, polls `GET /listings` until both `new_comment` and `item_sold` webhooks arrive and status is `sold`. Exits 0 on success, 1 on timeout.

---

## Secrets and security

- **No secrets in git** — the webhook HMAC key is auto-generated by CloudFormation (`GenerateSecretString`) and stored in Secrets Manager. Lambda functions receive only the ARN.
- **Webhook verification** — every incoming webhook is validated with HMAC-SHA256 over `timestamp.body` with a 5-minute replay window and timing-safe comparison.
- **Idempotency** — `POST /listings` requires an `Idempotency-Key` header; a DynamoDB GSI prevents duplicate listings on retries. FIFO SQS deduplicates publish jobs on `publishRequestId`. Webhooks dedup on `eventId` via a conditional DynamoDB `PutItem`.

---

## Cost

**Prototype-scale (≤ 100 listings/day)**: well under **$0.20/day**.

All services are pay-per-use: Lambda, HTTP API Gateway, DynamoDB on-demand, SQS, CloudFront, S3, Secrets Manager. No NAT Gateway, no idle ECS/RDS, no provisioned capacity. See [APPROACH.md](./APPROACH.md) for the full monthly cost breakdown at 10 sellers / 1k listings / 10k events.

---

## Observability

Three **CloudWatch alarms** are provisioned by the CDK stack:

| Alarm name | Triggers when |
|-----------|---------------|
| `marketplace-api-lambda-errors` | API Lambda errors ≥ 5 in 5 min |
| `marketplace-dlq-depth` | DLQ has ≥ 1 visible message |
| `marketplace-mock-worker-errors` | Worker errors ≥ 10 in 5 min |

To route alarms to email, add an SNS topic + subscription in CDK (one-line change) before deploy.

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/listings` | All listings with their recent activity |
| `POST` | `/listings` | Create listing + dispatch to mock marketplace |
| `POST` | `/listings/analyze` | AI image analysis (single or bulk mode) |
| `DELETE` | `/listings/:id` | Delete a listing and all its activity |
| `POST` | `/listings/batch-delete` | Delete up to 50 listings at once |
| `POST` | `/webhooks/marketplace` | Ingest signed marketplace event |
| `POST` | `/admin/replay-dlq` | Re-enqueue messages from the DLQ |

---

## Project layout

```
├── infra/
│   ├── bin/app.ts               # CDK entry point
│   ├── lib/marketplace-stack.ts # All infrastructure (one stack)
│   └── lambda/
│       ├── api-handler.ts       # Main API + webhook receiver
│       ├── mock-accept.ts       # Mock marketplace ingress
│       ├── mock-worker.ts       # Async worker (delays, failures, webhooks)
│       └── shared.ts            # HMAC helpers, CORS headers
├── frontend/
│   └── public/                  # index.html · styles.css · app.js
├── scripts/
│   └── smoke-test.mjs           # Post-deploy integration test
├── APPROACH.md                  # Architecture, safety, cost write-up
└── README.md                    # This file
```

---

## Judgement calls

- **Auth omitted** — basic auth was prototyped (shared token via Secrets Manager) but removed to keep the demo frictionless. Production direction: Cognito + `sellerId` on every DynamoDB row.
- **CloudFront → API path rewrite** — viewer requests to `/api/*` are stripped of the `/api` prefix by a CloudFront Function before forwarding to API Gateway. This lets the browser use a single origin with no CORS preflight on same-host requests.
- **Single region** — `us-west-2` (Oregon). Multi-region and multi-account are out of scope per the brief.
- **No real marketplace OAuth** — eBay is the conceptual reference; see APPROACH.md for the real auth/rate-limit story.
