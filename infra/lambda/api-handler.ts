import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "crypto";
import {
  corsHeaders,
  jsonResponse,
  verifyWebhookSignature,
  WEBHOOK_SIG_HEADER,
  WEBHOOK_TS_HEADER,
} from "./shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sm = new SecretsManagerClient({});
const sqs = new SQSClient({});
const bedrock = new BedrockRuntimeClient({});

const LISTINGS_TABLE = process.env.LISTINGS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const IDEMPOTENCY_INDEX = process.env.IDEMPOTENCY_INDEX_NAME!;
const MOCK_PUBLISH_URL = process.env.MOCK_PUBLISH_URL!;
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN!;
const MOCK_DLQ_URL = process.env.MOCK_DLQ_URL!;
const MOCK_QUEUE_URL = process.env.MOCK_QUEUE_URL!;

let cachedWebhookSecret: string | undefined;

async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  const out = await sm.send(
    new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN })
  );
  const s = out.SecretString;
  if (!s) throw new Error("Webhook secret missing");
  cachedWebhookSecret = s;
  return s;
}

type Listing = {
  listingId: string;
  title: string;
  description: string;
  priceCents: number;
  status: string;
  idempotencyKey?: string;
  marketplaceListingId?: string;
  publishRequestId: string;
  /** Optional product image (HTTPS URL). */
  photoUrl?: string;
  createdAt: string;
  updatedAt: string;
};

type ActivityItem = {
  listingId: string;
  activityId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  try {
    if (path === "/listings" && method === "GET") return await listListings();
    if (path === "/listings" && method === "POST") return await createListing(event);
    if (path === "/listings/analyze" && method === "POST") return await analyzeListing(event);
    if (path === "/listings/batch-delete" && method === "POST") return await batchDeleteListings(event);
    if (path === "/admin/replay-dlq" && method === "POST") return await replayDlq();
    if (path === "/webhooks/marketplace" && method === "POST") return await ingestWebhook(event);

    // Parameterized: /listings/{listingId}
    const segs = path.split("/").filter(Boolean);
    if (segs[0] === "listings" && segs.length === 2) {
      if (method === "DELETE") return await deleteListing(segs[1]);
    }

    return jsonResponse(404, { error: "not_found" });
  } catch (e) {
    console.error(e);
    return jsonResponse(500, { error: "internal_error" });
  }
}

async function listListings(): Promise<APIGatewayProxyResultV2> {
  const listingsOut = await ddb.send(
    new ScanCommand({
      TableName: LISTINGS_TABLE,
      FilterExpression: "attribute_exists(#t)",
      ExpressionAttributeNames: { "#t": "title" },
    })
  );
  const listings = (listingsOut.Items ?? []) as Listing[];
  listings.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const withActivity = await Promise.all(
    listings.map(async (l) => {
      const act = await ddb.send(
        new QueryCommand({
          TableName: ACTIVITY_TABLE,
          KeyConditionExpression: "listingId = :lid",
          ExpressionAttributeValues: { ":lid": l.listingId },
          ScanIndexForward: false,
          Limit: 10,
        })
      );
      return { ...l, recentActivity: (act.Items ?? []) as ActivityItem[] };
    })
  );

  return jsonResponse(200, { listings: withActivity });
}

async function createListing(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const idempotencyKey =
    event.headers["idempotency-key"] ?? event.headers["Idempotency-Key"];
  if (!idempotencyKey?.trim()) {
    return jsonResponse(400, { error: "idempotency_key_required" });
  }

  let body: {
    title?: string;
    description?: string;
    price?: number;
    priceCents?: number;
    photoUrl?: string;
  };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const title = (body.title ?? "").trim();
  const description = (body.description ?? "").trim();
  const priceCents =
    typeof body.priceCents === "number"
      ? Math.round(body.priceCents)
      : typeof body.price === "number"
        ? Math.round(body.price * 100)
        : NaN;

  if (!title || !description || !Number.isFinite(priceCents) || priceCents < 0) {
    return jsonResponse(400, { error: "invalid_listing_fields" });
  }

  const rawPhoto = typeof body.photoUrl === "string" ? body.photoUrl.trim() : "";
  let photoUrl: string | undefined;
  if (rawPhoto) {
    try {
      const u = new URL(rawPhoto);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return jsonResponse(400, { error: "invalid_photo_url" });
      }
      if (rawPhoto.length > 2048) {
        return jsonResponse(400, { error: "invalid_photo_url" });
      }
      photoUrl = rawPhoto;
    } catch {
      return jsonResponse(400, { error: "invalid_photo_url" });
    }
  }

  const dup = await ddb.send(
    new QueryCommand({
      TableName: LISTINGS_TABLE,
      IndexName: IDEMPOTENCY_INDEX,
      KeyConditionExpression: "idempotencyKey = :k",
      ExpressionAttributeValues: { ":k": idempotencyKey },
      Limit: 1,
    })
  );
  if (dup.Items?.length) {
    return jsonResponse(200, { listing: dup.Items[0], idempotentReplay: true });
  }

  const listingId = randomUUID();
  const publishRequestId = randomUUID();
  const now = new Date().toISOString();

  const listing: Listing = {
    listingId,
    title,
    description,
    priceCents,
    status: "pending_publish",
    idempotencyKey,
    publishRequestId,
    ...(photoUrl ? { photoUrl } : {}),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: LISTINGS_TABLE,
        Item: listing,
        ConditionExpression: "attribute_not_exists(listingId)",
      })
    );
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) {
      return jsonResponse(409, { error: "conflict_retry" });
    }
    throw e;
  }

  const mockPayload = {
    publishRequestId,
    listingId,
    title,
    description,
    priceCents,
    marketplace: "mock_ebay",
  };

  try {
    const res = await fetch(MOCK_PUBLISH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mockPayload),
    });
    if (res.status !== 202) {
      const t = await res.text();
      console.warn("mock publish unexpected status", res.status, t);
      await ddb.send(
        new UpdateCommand({
          TableName: LISTINGS_TABLE,
          Key: { listingId },
          UpdateExpression: "SET #s = :s, updatedAt = :u, lastError = :e",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "publish_dispatch_failed",
            ":u": new Date().toISOString(),
            ":e": `mock_http_${res.status}`,
          },
        })
      );
      return jsonResponse(502, { error: "mock_publish_rejected", listingId });
    }
  } catch (e) {
    console.error("mock publish fetch failed", e);
    await ddb.send(
      new UpdateCommand({
        TableName: LISTINGS_TABLE,
        Key: { listingId },
        UpdateExpression: "SET #s = :s, updatedAt = :u",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "publish_dispatch_failed",
          ":u": new Date().toISOString(),
        },
      })
    );
    return jsonResponse(502, { error: "mock_unreachable", listingId });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: LISTINGS_TABLE,
      Key: { listingId },
      UpdateExpression: "SET #s = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "publishing",
        ":u": new Date().toISOString(),
      },
    })
  );

  return jsonResponse(201, { listing: { ...listing, status: "publishing" } });
}

async function analyzeListing(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  let body: { imageBase64?: string; mediaType?: string; bulk?: boolean };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const { imageBase64, mediaType = "image/jpeg", bulk = false } = body;
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return jsonResponse(400, { error: "imageBase64_required" });
  }
  // ~4 MB raw = ~5.5 MB base64
  if (imageBase64.length > 5_500_000) {
    return jsonResponse(413, { error: "image_too_large", detail: "Compress to under ~4 MB before sending." });
  }
  const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowedTypes.includes(mediaType)) {
    return jsonResponse(400, { error: "unsupported_media_type" });
  }

  const prompt = bulk
    ? `You are a marketplace listing assistant helping sell items online. Look at this image carefully.

TASK: Identify every distinct physical item visible (products, cards, electronics, clothing, collectibles, sports cards, toys, books — anything someone would buy).

OUTPUT FORMAT: Respond with ONLY a raw JSON array. No explanation, no markdown, no code fences. Start your response with [ and end with ].

Each element must have exactly these keys:
- "title": string, max 80 chars, be specific (include brand, model, player name, year if visible)
- "description": string, 2-3 sentences about condition, visible details, and what a buyer should know
- "suggestedPriceCents": integer, realistic USD resale price in cents (e.g. 999 = $9.99)

Example output: [{"title":"1992 Michael Jordan Upper Deck Card #23","description":"Basketball trading card in good condition. Light wear on edges, face shows clearly. Great addition to any Bulls collection.","suggestedPriceCents":2499}]

Return up to 10 items. Each card, item, or object in the photo is its own entry.`
    : "You are a marketplace listing assistant. Analyze this product image and return ONLY a valid JSON object with these exact fields (no markdown fences, no extra text):\n" +
      '- "title": string (max 80 chars, specific product name with brand/model if visible)\n' +
      '- "description": string (2-3 sentences covering condition, key features, and any visible details)\n' +
      '- "suggestedPriceCents": integer (realistic USD resale price in cents, e.g. 4999 for $49.99)';

  try {
    const raw = await bedrock.send(
      new InvokeModelCommand({
        modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: bulk ? 2048 : 512,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data: imageBase64 },
                },
                { type: "text", text: prompt },
              ],
            },
          ],
        }),
      })
    );
    const parsed = JSON.parse(Buffer.from(raw.body).toString("utf-8"));
    const text: string = parsed?.content?.[0]?.text ?? "";

    if (bulk) {
      // Strip markdown code fences if Claude added them
      const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();

      let arr: Array<{ title?: unknown; description?: unknown; suggestedPriceCents?: unknown }> | null = null;

      // Try bare array first
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try { arr = JSON.parse(arrMatch[0]); } catch { /* try next */ }
      }

      // Fallback: object with items / listings / results key
      if (!Array.isArray(arr)) {
        const objMatch = cleaned.match(/\{[\s\S]*\}/);
        if (objMatch) {
          try {
            const obj = JSON.parse(objMatch[0]) as Record<string, unknown>;
            const key = ["items", "listings", "results", "products"].find(k => Array.isArray(obj[k]));
            if (key) arr = obj[key] as typeof arr;
          } catch { /* fall through */ }
        }
      }

      if (!Array.isArray(arr) || arr.length === 0) {
        console.error("bulk parse failed, raw Claude response:", text);
        return jsonResponse(502, {
          error: "ai_parse_error",
          detail: `Claude didn't return a JSON array. Try a clearer photo with items well separated. (raw: ${text.slice(0, 200)})`,
        });
      }

      return jsonResponse(200, {
        items: arr.slice(0, 10).map((s) => ({
          title: String(s.title ?? "").trim().slice(0, 200),
          description: String(s.description ?? "").trim().slice(0, 4000),
          suggestedPriceCents: Math.max(0, Math.round(Number(s.suggestedPriceCents) || 0)),
        })),
      });
    }

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return jsonResponse(502, { error: "ai_parse_error", detail: "AI returned no JSON block." });
    }
    const s = JSON.parse(match[0]);
    return jsonResponse(200, {
      suggestion: {
        title: String(s.title ?? "").trim().slice(0, 200),
        description: String(s.description ?? "").trim().slice(0, 4000),
        suggestedPriceCents: Math.max(0, Math.round(Number(s.suggestedPriceCents) || 0)),
      },
    });
  } catch (e: unknown) {
    const name = (e as { name?: string })?.name ?? "";
    if (name === "AccessDeniedException" || name === "ResourceNotFoundException" || name === "ValidationException") {
      return jsonResponse(503, {
        error: "bedrock_unavailable",
        detail:
          "Enable Claude Haiku 4.5 model access: AWS Console → Amazon Bedrock → Model catalog → Claude Haiku 4.5 → Open in playground (us-west-2).",
      });
    }
    throw e;
  }
}

async function deleteListingData(listingId: string): Promise<void> {
  // Query all activity for this listing, then batch-delete
  const acts = await ddb.send(
    new QueryCommand({
      TableName: ACTIVITY_TABLE,
      KeyConditionExpression: "listingId = :lid",
      ExpressionAttributeValues: { ":lid": listingId },
      ProjectionExpression: "activityId",
    })
  );
  const items = acts.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [ACTIVITY_TABLE]: items.slice(i, i + 25).map((it) => ({
            DeleteRequest: { Key: { listingId, activityId: it.activityId } },
          })),
        },
      })
    );
  }
  await ddb.send(new DeleteCommand({ TableName: LISTINGS_TABLE, Key: { listingId } }));
}

async function deleteListing(listingId: string): Promise<APIGatewayProxyResultV2> {
  if (!listingId?.trim()) return jsonResponse(400, { error: "listingId_required" });
  await deleteListingData(listingId);
  return jsonResponse(200, { deleted: true, listingId });
}

async function batchDeleteListings(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  let body: { listingIds?: string[] };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const ids = body.listingIds ?? [];
  if (!Array.isArray(ids) || ids.length === 0)
    return jsonResponse(400, { error: "listingIds_required" });
  if (ids.length > 50)
    return jsonResponse(400, { error: "too_many_ids", detail: "Max 50 per batch" });

  await Promise.all(ids.map((id) => deleteListingData(id)));
  return jsonResponse(200, { deleted: ids.length });
}

async function replayDlq(): Promise<APIGatewayProxyResultV2> {
  const msgs = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: MOCK_DLQ_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    })
  );
  let replayed = 0;
  const received = msgs.Messages?.length ?? 0;

  for (const msg of msgs.Messages ?? []) {
    if (!msg.Body || !msg.ReceiptHandle) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(msg.Body);
    } catch {
      /* unparseable; skip */
    }
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: MOCK_QUEUE_URL,
          MessageBody: msg.Body,
          MessageGroupId: String(parsed.listingId ?? "replay"),
          // Fresh dedup ID — original may still be within SQS 5-min dedup window.
          MessageDeduplicationId: `replay-${String(parsed.publishRequestId ?? randomUUID())}-${Date.now()}`,
        })
      );
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: MOCK_DLQ_URL,
          ReceiptHandle: msg.ReceiptHandle,
        })
      );
      replayed++;
    } catch (err) {
      console.error("replay message failed", err);
    }
  }
  return jsonResponse(200, { replayed, received });
}

async function ingestWebhook(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const rawBody = event.body ?? "";
  const secret = await getWebhookSecret();
  const sig =
    event.headers[WEBHOOK_SIG_HEADER] ?? event.headers["X-Marketplace-Signature"];
  const ts =
    event.headers[WEBHOOK_TS_HEADER] ?? event.headers["X-Marketplace-Timestamp"];

  const v = verifyWebhookSignature(secret, rawBody, sig, ts);
  if (!v.ok) {
    return jsonResponse(401, { error: "invalid_webhook", detail: v.reason });
  }

  let msg: {
    type?: string;
    listingId?: string;
    marketplaceListingId?: string;
    publishRequestId?: string;
    comment?: string;
    eventId?: string;
  };
  try {
    msg = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const type = msg.type;
  const listingId = msg.listingId;
  if (!listingId || (type !== "item_sold" && type !== "new_comment")) {
    return jsonResponse(400, { error: "invalid_event" });
  }

  const eventId = msg.eventId;
  if (!eventId || typeof eventId !== "string") {
    return jsonResponse(400, { error: "event_id_required" });
  }

  const createdAt = new Date().toISOString();

  try {
    await ddb.send(
      new PutCommand({
        TableName: ACTIVITY_TABLE,
        Item: {
          listingId,
          activityId: eventId,
          type,
          payload: msg as Record<string, unknown>,
          createdAt,
        },
        ConditionExpression: "attribute_not_exists(activityId)",
      })
    );
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) {
      return jsonResponse(200, { ok: true, duplicate: true });
    }
    throw e;
  }

  if (type === "item_sold") {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: LISTINGS_TABLE,
          Key: { listingId },
          UpdateExpression:
            "SET #s = :sold, marketplaceListingId = :m, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":sold": "sold",
            ":live": "live",
            ":publishing": "publishing",
            ":m": msg.marketplaceListingId ?? "unknown",
            ":u": createdAt,
          },
          ConditionExpression: "#s IN (:live, :publishing)",
        })
      );
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
    }
  } else {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: LISTINGS_TABLE,
          Key: { listingId },
          UpdateExpression:
            "SET #s = :live, marketplaceListingId = if_not_exists(marketplaceListingId, :m), updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":live": "live",
            ":publishing": "publishing",
            ":m": msg.marketplaceListingId ?? "unknown",
            ":u": createdAt,
          },
          ConditionExpression: "#s = :publishing",
        })
      );
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
      await ddb.send(
        new UpdateCommand({
          TableName: LISTINGS_TABLE,
          Key: { listingId },
          UpdateExpression:
            "SET marketplaceListingId = if_not_exists(marketplaceListingId, :m), updatedAt = :u",
          ExpressionAttributeValues: {
            ":m": msg.marketplaceListingId ?? "unknown",
            ":u": createdAt,
          },
        })
      );
    }
  }

  return jsonResponse(200, { ok: true });
}
