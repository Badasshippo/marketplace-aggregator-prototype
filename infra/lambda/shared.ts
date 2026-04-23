import { createHmac, timingSafeEqual } from "crypto";

export const WEBHOOK_SIG_HEADER = "x-marketplace-signature";
export const WEBHOOK_TS_HEADER = "x-marketplace-timestamp";

export function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>
) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "content-type,idempotency-key,x-marketplace-signature,x-marketplace-timestamp",
  };
}

export function signWebhookBody(secret: string, rawBody: string, timestamp: string) {
  const payload = `${timestamp}.${rawBody}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined
): { ok: true } | { ok: false; reason: string } {
  if (!signature || !timestamp) {
    return { ok: false, reason: "missing signature or timestamp" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    return { ok: false, reason: "stale or invalid timestamp" };
  }
  const expected = signWebhookBody(secret, rawBody, timestamp);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "invalid signature" };
    }
  } catch {
    return { ok: false, reason: "signature compare failed" };
  }
  return { ok: true };
}

export function randomFailRate(): boolean {
  // ~15% synthetic failure (assignment: 10–20%)
  return Math.random() < 0.15;
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}
