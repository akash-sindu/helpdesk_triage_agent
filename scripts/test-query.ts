import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embedQuery } from "../backend/src/embeddings.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in the environment or .env`);
  return value;
}

async function main() {
  const title = process.argv[2] ?? "Troubleshooting VPN connection failures from home";
  const description =
    process.argv[3] ??
    "My VPN client will not connect while I am working from home, although my home internet works.";
  const qdrant = new QdrantClient({
    url: requiredEnv("QDRANT_URL"),
    apiKey: requiredEnv("QDRANT_API_KEY"),
  });
  const result = await qdrant.query(
    requiredEnv("QDRANT_COLLECTION"),
    { query: await embedQuery(`${title}\n${description}`), limit: 5, with_payload: true },
  );
  console.log(
    JSON.stringify(
      result.points.map((point) => ({
        articleId: point.payload?.articleId,
        title: point.payload?.title,
        category: point.payload?.category,
        score: point.score,
      })),
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error("Qdrant sample query failed:", error);
  process.exitCode = 1;
});