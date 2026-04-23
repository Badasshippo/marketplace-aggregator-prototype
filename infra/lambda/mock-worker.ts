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

const BUYER_QUESTIONS = [
  "Does this come with the original packaging and accessories?",
  "What is the shipping time to California? Can you do expedited?",
  "Is there any damage not shown in the photos?",
  "Would you consider a trade instead of cash?",
  "How long have you owned this item?",
];

const BUYER_COMMENTS = [
  "Buyer: Is this still available?",
  "Buyer: I'm very interested, can you hold it for me?",
  "Buyer: Just saw your listing — looks great!",
  "Buyer: Does the price include shipping?",
];

export async function handler(event: SQSEvent) {
  for (const record of event.Records) {
    const msg = JSON.parse(record.body) as {
      publishRequestId: string;
      listingId: string;
      priceCents?: number;
      title?: string;
    };

    // Initial delay: listing processing on marketplace side (5–15s)
    await sleep(5000 + Math.floor(Math.random() * 10000));

    if (randomFailRate()) {
      throw new Error("synthetic_marketplace_failure");
    }

    const marketplaceListingId = `MOCK-EBAY-${randomUUID().slice(0, 8)}`;
    const priceCents = msg.priceCents ?? 10000;

    // 1. A buyer sees the listing and asks a question (15–40s after it goes live)
    await sleep(15000 + Math.floor(Math.random() * 25000));
    await postWebhook({
      type: "new_question",
      eventId: `${msg.publishRequestId}-question`,
      listingId: msg.listingId,
      marketplaceListingId,
      question: BUYER_QUESTIONS[Math.floor(Math.random() * BUYER_QUESTIONS.length)],
      buyerName: "buyer_" + randomUUID().slice(0, 5),
      publishRequestId: msg.publishRequestId,
    });

    // 2. Another buyer (or same one) leaves a comment (20–45s later)
    await sleep(20000 + Math.floor(Math.random() * 25000));
    await postWebhook({
      type: "new_comment",
      eventId: `${msg.publishRequestId}-comment`,
      listingId: msg.listingId,
      marketplaceListingId,
      comment: BUYER_COMMENTS[Math.floor(Math.random() * BUYER_COMMENTS.length)],
      publishRequestId: msg.publishRequestId,
    });

    // 3. ~45% chance of a price-change request (20–50s later)
    await sleep(20000 + Math.floor(Math.random() * 30000));
    if (Math.random() < 0.45) {
      const offerFraction = 0.62 + Math.random() * 0.22; // 62–84% of asking price
      const offeredPriceCents = Math.round(priceCents * offerFraction);
      await postWebhook({
        type: "price_change_request",
        eventId: `${msg.publishRequestId}-price`,
        listingId: msg.listingId,
        marketplaceListingId,
        offeredPriceCents,
        originalPriceCents: priceCents,
        buyerMessage: "Would you take a lower offer? I can pay right away.",
        publishRequestId: msg.publishRequestId,
      });
      await sleep(20000 + Math.floor(Math.random() * 20000));
    }

    // 4. Item sells (30–60s after last event)
    await sleep(30000 + Math.floor(Math.random() * 30000));
    await postWebhook({
      type: "item_sold",
      eventId: `${msg.publishRequestId}-sold`,
      listingId: msg.listingId,
      marketplaceListingId,
      publishRequestId: msg.publishRequestId,
    });
  }
}
