import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { corsHeaders, jsonResponse } from "./shared";

const sqs = new SQSClient({});
const QUEUE_URL = process.env.MOCK_QUEUE_URL!;

/** Mock marketplace ingress — accepts publish, returns 202, enqueues async work. */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.requestContext.http.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const publishRequestId = body.publishRequestId;
  const listingId = body.listingId;
  if (typeof publishRequestId !== "string" || typeof listingId !== "string") {
    return jsonResponse(400, { error: "invalid_publish_payload" });
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(body),
      MessageGroupId: listingId,
      MessageDeduplicationId: publishRequestId,
    })
  );

  return { statusCode: 202, headers: corsHeaders(), body: "" };
}
