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
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
const s3client = new S3Client({});

const LISTINGS_TABLE = process.env.LISTINGS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const IDEMPOTENCY_INDEX = process.env.IDEMPOTENCY_INDEX_NAME!;
const MOCK_PUBLISH_URL = process.env.MOCK_PUBLISH_URL!;
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN!;
const MOCK_DLQ_URL = process.env.MOCK_DLQ_URL!;
const MOCK_QUEUE_URL = process.env.MOCK_QUEUE_URL!;
const PHOTOS_BUCKET = process.env.PHOTOS_BUCKET!;
const PHOTOS_BASE_URL = process.env.PHOTOS_BASE_URL!;

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
    if (path === "/listings/photo-upload-url" && method === "POST") return await getPhotoUploadUrl(event);
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
    ? `You are an expert marketplace listing assistant with deep knowledge of resale prices. Look at this image carefully.

TASK: Identify EVERY distinct physical item visible. Treat each card, object, or product as its own separate entry — even if multiple are the same type.

OUTPUT FORMAT: ONLY a raw JSON array. Start with [ and end with ]. No markdown, no explanation.

Each element must have exactly these keys:
- "title": string, max 80 chars — be specific: brand, model, player name, year, card set/number, specs
- "condition": one of exactly "New" | "Like New" | "Good" | "Fair" | "Poor"
- "description": string, 2 sentences — what it is and its specific visible condition/details
- "suggestedPriceCents": integer — realistic USD resale cents based on condition and item rarity

Example: [{"title":"1986 Fleer Michael Jordan #57 Basketball Card","condition":"Good","description":"Jordan rookie-era card showing Bulls uniform clearly. Light corner wear, no creases.","suggestedPriceCents":24900}]

Return up to 10 items. For sports cards: include player, year, set name, and card number if visible.`
    : `You are an expert marketplace listing assistant with deep knowledge of resale prices. Analyze this product image and return ONLY a valid JSON object (no markdown, no text outside the braces):

Fields:
- "title": string, max 80 chars — include brand, model, year, key specs, or player/subject name if visible
- "condition": one of exactly: "New" | "Like New" | "Good" | "Fair" | "Poor" — assess from visible wear, scratches, yellowing, creases, packaging
- "description": string, 2-3 sentences — lead with what the item is, then note specific condition details visible in the image, then mention what a buyer should know (completeness, storage, provenance if obvious)
- "suggestedPriceCents": integer — realistic USD resale price in cents. Factor in condition: New=retail or above, Like New=80-95% of retail, Good=50-70%, Fair=25-45%, Poor=10-25%. For collectibles/cards factor in rarity and era.

Example: {"title":"1986 Fleer Michael Jordan Rookie Card #57","condition":"Good","description":"Classic Michael Jordan Fleer rookie card showing Jordan in his iconic Bulls uniform. Card shows moderate wear with light corner touches and centering slightly off. No creases or major defects visible.","suggestedPriceCents":29900}`;

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

      const validConds = ["New", "Like New", "Good", "Fair", "Poor"];
      return jsonResponse(200, {
        items: arr.slice(0, 10).map((s) => ({
          title: String(s.title ?? "").trim().slice(0, 200),
          condition: validConds.includes(s.condition as string) ? s.condition : null,
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
    const validConditions = ["New", "Like New", "Good", "Fair", "Poor"];
    const condition = validConditions.includes(s.condition) ? s.condition : null;
    return jsonResponse(200, {
      suggestion: {
        title: String(s.title ?? "").trim().slice(0, 200),
        condition,
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

async function getPhotoUploadUrl(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  let body: { mediaType?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const mediaType = body.mediaType ?? "image/jpeg";
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(mediaType)) {
    return jsonResponse(400, { error: "unsupported_media_type" });
  }
  const ext = mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "jpg";
  const key = `photos/${randomUUID()}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3client,
    new PutObjectCommand({ Bucket: PHOTOS_BUCKET, Key: key, ContentType: mediaType }),
    { expiresIn: 300 }
  );
  return jsonResponse(200, {
    uploadUrl,
    photoUrl: `${PHOTOS_BASE_URL}/${key}`,
  });
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

  const ACCEPTED_EVENTS = ["item_sold", "new_comment", "new_question", "price_change_request"];

  let msg: {
    type?: string;
    listingId?: string;
    marketplaceListingId?: string;
    publishRequestId?: string;
    comment?: string;
    question?: string;
    buyerName?: string;
    offeredPriceCents?: number;
    originalPriceCents?: number;
    buyerMessage?: string;
    eventId?: string;
  };
  try {
    msg = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const type = msg.type;
  const listingId = msg.listingId;
  if (!listingId || !type || !ACCEPTED_EVENTS.includes(type)) {
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

  // Transition listing state based on event type
  const mktId = msg.marketplaceListingId ?? "unknown";
  try {
    if (type === "item_sold") {
      // sold: terminal — only transition from live or publishing
      await ddb.send(new UpdateCommand({
        TableName: LISTINGS_TABLE,
        Key: { listingId },
        UpdateExpression: "SET #s = :sold, marketplaceListingId = :m, updatedAt = :u",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":sold": "sold", ":live": "live", ":publishing": "publishing",
          ":pending": "pending_review", ":m": mktId, ":u": createdAt,
        },
        ConditionExpression: "#s IN (:live, :publishing, :pending)",
      }));
    } else if (type === "price_change_request") {
      // pending_review: seller must act — transition live → pending_review
      await ddb.send(new UpdateCommand({
        TableName: LISTINGS_TABLE,
        Key: { listingId },
        UpdateExpression: "SET #s = :pending, marketplaceListingId = if_not_exists(marketplaceListingId, :m), updatedAt = :u",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":pending": "pending_review", ":live": "live", ":publishing": "publishing",
          ":m": mktId, ":u": createdAt,
        },
        ConditionExpression: "#s IN (:live, :publishing)",
      }));
    } else {
      // new_comment / new_question: mark listing live once marketplace confirms it
      await ddb.send(new UpdateCommand({
        TableName: LISTINGS_TABLE,
        Key: { listingId },
        UpdateExpression: "SET #s = :live, marketplaceListingId = if_not_exists(marketplaceListingId, :m), updatedAt = :u",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":live": "live", ":publishing": "publishing", ":m": mktId, ":u": createdAt,
        },
        ConditionExpression: "#s = :publishing",
      }));
    }
  } catch (e) {
    // ConditionalCheckFailed just means status was already past that state — safe to ignore
    if (!(e instanceof ConditionalCheckFailedException)) throw e;
    // Still update the marketplace listing id if somehow missed
    await ddb.send(new UpdateCommand({
      TableName: LISTINGS_TABLE,
      Key: { listingId },
      UpdateExpression: "SET marketplaceListingId = if_not_exists(marketplaceListingId, :m), updatedAt = :u",
      ExpressionAttributeValues: { ":m": mktId, ":u": createdAt },
    }));
  }

  return jsonResponse(200, { ok: true });
}
