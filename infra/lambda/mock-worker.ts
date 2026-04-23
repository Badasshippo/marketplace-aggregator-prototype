import type { SQSEvent } from "aws-lambda";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { randomUUID } from "crypto";
import {
  randomFailRate,
  signWebhookBody,
  sleep,
  WEBHOOK_SIG_HEADER,
  WEBHOOK_TS_HEADER,
} from "./shared";

const sm = new SecretsManagerClient({});

const WEBHOOK_URL = process.env.WEBHOOK_URL!;
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN!;

let cachedSecret: string | undefined;

async function getSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const out = await sm.send(
    new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN })
  );
  if (!out.SecretString) throw new Error("missing secret");
  cachedSecret = out.SecretString;
  return out.SecretString;
}

async function postWebhook(payload: Record<string, unknown>) {
  const secret = await getSecret();
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = signWebhookBody(secret, rawBody, timestamp);
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WEBHOOK_SIG_HEADER]: signature,
      [WEBHOOK_TS_HEADER]: timestamp,
    },
    body: rawBody,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`webhook failed ${res.status}: ${t}`);
  }
}

export async function handler(event: SQSEvent) {
  for (const record of event.Records) {
    const msg = JSON.parse(record.body) as {
      publishRequestId: string;
      listingId: string;
      title?: string;
    };

    await sleep(1500 + Math.floor(Math.random() * 2500));

    if (randomFailRate()) {
      throw new Error("synthetic_marketplace_failure");
    }

    const marketplaceListingId = `MOCK-EBAY-${randomUUID().slice(0, 8)}`;

    await postWebhook({
      type: "new_comment",
      eventId: `${msg.publishRequestId}-comment`,
      listingId: msg.listingId,
      marketplaceListingId,
      comment: "Buyer: Is this still available?",
      publishRequestId: msg.publishRequestId,
    });

    await sleep(800 + Math.floor(Math.random() * 1200));

    await postWebhook({
      type: "item_sold",
      eventId: `${msg.publishRequestId}-sold`,
      listingId: msg.listingId,
      marketplaceListingId,
      publishRequestId: msg.publishRequestId,
    });
  }
}
