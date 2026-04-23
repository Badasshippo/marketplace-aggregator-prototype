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
- **WebhookSecretArn** — generated secret (never committed); Lambdas read it at runtime.

## Tear down

```bash
npm run destroy
```

(`cdk destroy --all --force` from `infra/`.) Empty the versioned bucket if `cdk destroy` warns about retained objects—this stack uses `autoDeleteObjects` on the site bucket to keep teardown simple.

## Local usage (no AWS)

Not supported end-to-end (the app is intentionally serverless). For local experiments, run `npm run build` and inspect `infra/cdk.out` after `cd infra && npx cdk synth`.

## Triggering mock events

Normal flow: create a listing in the UI. The API Lambda `POST`s to the mock ingress; the mock enqueues FIFO SQS work; the worker applies ~**15%** synthetic failures (SQS retries), then posts **two signed webhooks** (`new_comment` then `item_sold`).

**Dead letters**: after **6** failed receives, messages land in the FIFO DLQ (`MockPublishDLQ`) for inspection.

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

## Observability (first alarms)

If this were production-adjacent, the first CloudWatch alarms would be:

1. **API Lambda errors + duration p95** (throttles / cold starts).  
2. **Mock worker errors** and **DLQ depth > 0**.  
3. **HTTP API 5xx** count.  
4. **DynamoDB** `UserErrors` / throttling (signals hot keys).

## Assumptions / judgement calls

- **CloudFront → API**: viewer path `/api/listings` is rewritten to `/listings` at the API origin so the browser can use relative `/api` URLs.  
- **eBay** is the conceptual reference marketplace (see APPROACH.md); integration is fully mocked.  
- **Auth**: omitted (nice-to-have in the brief); add API keys or Cognito before any real data.

## Project layout

- `infra/` — CDK stack, Lambda handlers (`infra/lambda/`)  
- `frontend/public/` — static UI copied to `frontend/dist` on build  
- `scripts/smoke-test.mjs` — optional post-deploy check  
