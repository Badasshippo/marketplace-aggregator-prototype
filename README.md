# Marketplace aggregator prototype

Senior engineer assignment (**Variant 2 — approach + prototype**): unified listing creation, mocked third-party marketplace (async, flaky, rate-limited), signed webhooks (`new_comment`, `item_sold`), DynamoDB persistence, static UI behind CloudFront. The UI includes optional product image (HTTPS URL), live polling until listings settle, and security headers on the static origin.

See [APPROACH.md](./APPROACH.md) for architecture, eBay reference notes, safety, and cost.

## Prerequisites

- Node.js **20+**
- AWS CLI v2 configured (`aws sts get-caller-identity` works)
- CDK bootstrap once per account/region:

  ```bash
  npx aws-cdk@2 bootstrap aws://ACCOUNT_ID/REGION
  ```

## One-command deploy (from a clean clone)

```bash
npm install --prefix infra && npm install --prefix frontend && npm run deploy
```

This builds the static site into `frontend/dist`, compiles the CDK app, runs `cdk deploy --all --require-approval never` from `infra/`, uploads assets, and invalidates CloudFront.

### Outputs

After deploy, note:

- **CloudFrontURL** — open in a browser (UI calls `/api/...` on the same host).
- **HttpApiUrl** — direct API Gateway base URL (for `curl` / smoke tests).
- **MockPublishFunctionUrl** — mock marketplace ingress (also invoked by the API Lambda).
- **WebhookSecretArn** — generated HMAC secret (never committed); Lambdas read it at runtime.
- **AuthTokenArn** — Secrets Manager ARN for the shared frontend API token.
- **GetAuthTokenCommand** — paste this command in your terminal to retrieve the token.

### First login

The UI requires an API key on first load. Get it by running the **GetAuthTokenCommand** value from the stack outputs:

```bash
aws secretsmanager get-secret-value --secret-id <AuthTokenArn> --query SecretString --output text --region us-west-2
```

Paste the token into the login screen. It is saved in `localStorage` for subsequent visits.

## Tear down

```bash
npm run destroy
```

(`cdk destroy --all --force` from `infra/`.) Empty the versioned bucket if `cdk destroy` warns about retained objects—this stack uses `autoDeleteObjects` on the site bucket to keep teardown simple.

## Local usage (no AWS)

Not supported end-to-end (the app is intentionally serverless). For local experiments, run `npm run build` and inspect `infra/cdk.out` after `cd infra && npx cdk synth`.

## Triggering mock events

Normal flow: create a listing in the UI. The API Lambda `POST`s to the mock ingress; the mock enqueues FIFO SQS work; the worker applies ~**15%** synthetic failures (SQS retries), then posts **two signed webhooks** (`new_comment` then `item_sold`).

**Dead letters**: after **6** failed receives, messages land in the FIFO DLQ (`MockPublishDLQ`). Use the **Replay DLQ** button in the UI (or `POST /api/admin/replay-dlq`) to re-enqueue them.

## AI photo → listing (✨ AI from photo tab)

1. Enable **Claude 3 Haiku** model access in the AWS console:  
   **Amazon Bedrock → Model access → Anthropic: Claude 3 Haiku → Request access** (us-west-2).  
   This is a one-time, usually-instant approval in your account.
2. In the UI, click **✨ AI from photo**, upload or take a photo of the item you want to sell.
3. Click **Analyze with AI** — Claude identifies the item and suggests a title, description, and price.
4. The form is pre-filled; edit anything you want, then click **Publish to mock marketplace**.

The Lambda endpoint is `POST /api/listings/analyze` (requires `Authorization: Bearer <token>`, accepts `{ imageBase64, mediaType }`). If Bedrock model access is not enabled, the API returns a `503` with instructions.

## Smoke test (deployed API)

```bash
export API_URL="https://YOUR_API_ID.execute-api.REGION.amazonaws.com"
node scripts/smoke-test.mjs
```

Uses `POST /listings` and polls `GET /listings` until activity shows both events and status `sold`.

## Secrets

No AWS keys or marketplace tokens belong in git. The webhook HMAC secret is **created by CloudFormation** (Secrets Manager `GenerateSecretString`) at deploy time. Lambdas receive the **ARN** only.

## Cost (leave running ~1 day)

Prototype-scale traffic is usually **well under a few dollars** for 24h: Lambda, HTTP API, DynamoDB on-demand, SQS, CloudFront data transfer, Secrets Manager (~$0.02/day of the monthly secret charge prorated), and S3. **NAT Gateway / idle ECS / provisioned RDS** are deliberately avoided. Re-check the [AWS pricing calculator](https://calculator.aws/) for your region.

## Observability

Three **CloudWatch alarms** are deployed with the stack (visible in the CloudWatch console):

| Alarm | Condition |
|-------|-----------|
| `marketplace-api-lambda-errors` | API Lambda errors ≥ 5 in a 5-min window |
| `marketplace-dlq-depth` | DLQ visible messages ≥ 1 |
| `marketplace-mock-worker-errors` | Worker errors ≥ 10 in 5 min (synthetic ~15% expected) |

To receive email notifications, add an **SNS topic + email subscription** to each alarm in the CloudWatch console, or wire it in CDK before deploy.

## Assumptions / judgement calls

- **CloudFront → API**: viewer path `/api/listings` is rewritten to `/listings` at the API origin so the browser can use relative `/api` URLs.  
- **eBay** is the conceptual reference marketplace (see APPROACH.md); integration is fully mocked.  
- **Auth**: omitted (nice-to-have in the brief); add API keys or Cognito before any real data.

## Project layout

- `infra/` — CDK stack, Lambda handlers (`infra/lambda/`)  
- `frontend/public/` — static UI copied to `frontend/dist` on build  
- `scripts/smoke-test.mjs` — optional post-deploy check  
