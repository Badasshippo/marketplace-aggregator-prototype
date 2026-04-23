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
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
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

const LISTINGS_TABLE = process.env.LISTINGS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const IDEMPOTENCY_INDEX = process.env.IDEMPOTENCY_INDEX_NAME!;
const MOCK_PUBLISH_URL = process.env.MOCK_PUBLISH_URL!;
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN!;

let cachedSecret: string | undefined;

async function getWebhookSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const out = await sm.send(
    new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN })
  );
  const s = out.SecretString;
  if (!s) throw new Error("Webhook secret missing");
  cachedSecret = s;
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
  /** Optional product image (HTTPS URL); assignment allows photos to be optional. */
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
    if (path === "/listings" && method === "GET") {
      return await listListings();
    }
    if (path === "/listings" && method === "POST") {
      return await createListing(event);
    }
    if (path === "/webhooks/marketplace" && method === "POST") {
      return await ingestWebhook(event);
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

  const withActivity: Array<
    Listing & { recentActivity: ActivityItem[] }
  > = await Promise.all(
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
      return {
        ...l,
        recentActivity: (act.Items ?? []) as ActivityItem[],
      };
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
    return jsonResponse(200, {
      listing: dup.Items[0],
      idempotentReplay: true,
    });
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
          UpdateExpression:
            "SET #s = :s, updatedAt = :u, lastError = :e",
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

  return jsonResponse(201, {
    listing: { ...listing, status: "publishing" },
  });
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
  if (
    !listingId ||
    (type !== "item_sold" && type !== "new_comment")
  ) {
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
