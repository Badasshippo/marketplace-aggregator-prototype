#!/usr/bin/env node
/**
 * Smoke test against a *deployed* stack. Uses the HTTP API URL (not CloudFront),
 * so paths are /listings not /api/listings.
 *
 * Usage:
 *   API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com node scripts/smoke-test.mjs
 */
const apiUrl = process.env.API_URL?.replace(/\/$/, "");
if (!apiUrl) {
  console.error("Set API_URL to the HttpApiUrl stack output.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const idem = crypto.randomUUID();
  const title = `Smoke ${new Date().toISOString()}`;

  const create = await fetch(`${apiUrl}/listings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idem,
    },
    body: JSON.stringify({
      title,
      description: "Automated smoke test listing",
      price: 12.34,
    }),
  });
  const createBody = await create.text();
  if (!create.ok) {
    console.error("POST /listings failed", create.status, createBody);
    process.exit(1);
  }
  console.log("Created listing:", createBody.slice(0, 200));

  const deadline = Date.now() + 120_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/listings`);
    const data = await res.json();
    const listing = data.listings?.find((l) => l.title === title);
    const n = listing?.recentActivity?.length ?? 0;
    if (n !== lastCount) {
      console.log("Activity count:", n, listing?.status);
      lastCount = n;
    }
    if (n >= 2 && listing?.status === "sold") {
      console.log("Smoke test passed: webhook events ingested and listing sold.");
      return;
    }
    await sleep(3000);
  }
  console.error("Timeout waiting for mock webhooks (check mock worker logs / DLQ).");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
