import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ChatGroq } from "@langchain/groq";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import { DEFAULT_COLLECTION_NAME, embedQuery } from "./embeddings.js";
import { hasValidApiKey } from "./auth.js";
import { logError, logInfo, logWarn } from "./logging.js";
import { buildTriageGraph } from "./graph.js";
import { createInitialState } from "./state.js";

const secretSchema = z.object({
  GROQ_API_KEY: z.string().min(1),
  QDRANT_URL: z.string().url(),
  QDRANT_API_KEY: z.string().min(1),
  TICKET_API_KEY: z.string().min(32),
});
type TriageSecrets = z.infer<typeof secretSchema>;

const ticketInputSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});
let graphPromise: ReturnType<typeof createGraph> | undefined;
let secretsPromise: Promise<TriageSecrets> | undefined;

function getSecrets() {
  const secretArn = process.env.TRIAGE_SECRET_ARN;
  if (!secretArn) throw new Error("Triage secret is not configured");
  if (!secretsPromise) {
    logInfo("secrets.load.started");
    secretsPromise = secretsClient
      .send(new GetSecretValueCommand({ SecretId: secretArn }))
      .then((result) => {
        if (!result.SecretString) {
          throw new Error("Triage secret has no string value");
        }
        const secrets = secretSchema.parse(JSON.parse(result.SecretString));
        logInfo("secrets.load.completed");
        return secrets;
      })
      .catch((error: unknown) => {
        logError("secrets.load.failed", error);
        secretsPromise = undefined;
        throw error;
      });
  }
  return secretsPromise;
}

async function createGraph() {
  const tableName = process.env.TICKETS_TABLE;
  const collectionName = process.env.QDRANT_COLLECTION ?? DEFAULT_COLLECTION_NAME;
  const model = process.env.GROQ_CHAT_MODEL;
  if (!tableName || !collectionName || !model) {
    throw new Error("Required Lambda configuration is missing");
  }

  logInfo("triage.graph.initialization.started", {
    collectionName,
    model,
  });
  const secret = await getSecrets();
  const chatModel = new ChatGroq({
    apiKey: secret.GROQ_API_KEY,
    model,
    temperature: 0,
    maxRetries: 0,
    timeout: 12000,
  });
  const qdrant = new QdrantClient({
    url: secret.QDRANT_URL,
    apiKey: secret.QDRANT_API_KEY,
  });

  const graph = buildTriageGraph({
    chatModel,
    embedQuery,
    qdrant,
    collectionName,
    persist: async (state) => {
      await documentClient.send(
        new PutCommand({ TableName: tableName, Item: state }),
      );
    },
  });
  logInfo("triage.graph.initialization.completed", {
    collectionName,
    model,
  });
  return graph;
}

function getGraph() {
  graphPromise ??= createGraph();
  return graphPromise;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

async function listTickets() {
  const tableName = process.env.TICKETS_TABLE;
  if (!tableName) throw new Error("Ticket table is not configured");
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "ticketId, title, #ticketStatus, createdAt, updatedAt",
        ExpressionAttributeNames: { "#ticketStatus": "status" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  items.sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)),
  );
  logInfo("tickets.list.completed", { count: items.length });
  return jsonResponse(200, { tickets: items });
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const requestId = event.requestContext.requestId;
  logInfo("http.request.received", { requestId, method, path });

  try {
    const providedApiKey = Object.entries(event.headers).find(
      ([name]) => name.toLowerCase() === "x-api-key",
    )?.[1];
    const { TICKET_API_KEY } = await getSecrets();
    if (!hasValidApiKey(providedApiKey, TICKET_API_KEY)) {
      logWarn("http.authorization.rejected", { requestId, method, path });
      return jsonResponse(401, { message: "Unauthorized" });
    }
    logInfo("http.authorization.accepted", { requestId, method, path });

    if (method === "GET" && path === "/tickets") return await listTickets();
    if (method !== "POST" || path !== "/tickets") {
      logWarn("http.route.not_found", { requestId, method, path });
      return jsonResponse(404, { message: "Route not found" });
    }
    if (!event.body) {
      logWarn("http.request.body_missing", { requestId });
      return jsonResponse(400, { message: "Request body is required" });
    }

    let body: unknown;
    try {
      body = JSON.parse(
        event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body,
      );
    } catch {
      logWarn("http.request.json_invalid", { requestId });
      return jsonResponse(400, { message: "Request body must be valid JSON" });
    }
    const input = ticketInputSchema.safeParse(body);
    if (!input.success) {
      logWarn("http.request.validation_failed", {
        requestId,
        issueFields: input.error.issues.map((issue) => issue.path.join(".")),
      });
      return jsonResponse(400, {
        message: "A title and description are required",
      });
    }

    const graph = await getGraph();
    const initialState = createInitialState({
      ticketId: randomUUID(),
      title: input.data.title,
      description: input.data.description,
    });
    logInfo("triage.invocation.started", {
      requestId,
      ticketId: initialState.ticketId,
    });
    const result = await graph.invoke(initialState);
    logInfo("triage.invocation.completed", {
      requestId,
      ticketId: result.ticketId,
      status: result.status,
      category: result.category,
      citedArticleCount: result.citedArticleIds.length,
    });
    return jsonResponse(200, {
      ticketId: result.ticketId,
      title: result.title,
      status: result.status,
      finalMessageToUser: result.finalMessageToUser,
      citedArticleIds: result.citedArticleIds,
      category: result.category,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      retrievedArticles: result.retrievedArticles,
      auditLog: result.auditLog,
    });
  } catch (error) {
    logError("http.request.failed", error, { requestId, method, path });
    return jsonResponse(500, {
      message: "Ticket processing failed. Please try again later.",
    });
  }
};