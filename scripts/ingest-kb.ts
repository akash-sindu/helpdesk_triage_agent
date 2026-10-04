import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  DEFAULT_COLLECTION_NAME,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedTexts,
} from "../backend/src/embeddings.js";

interface Article {
  id: string;
  title: string;
  category: string;
  content: string;
  stub: boolean;
}

const collectionName = process.env.QDRANT_COLLECTION ?? DEFAULT_COLLECTION_NAME;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in the environment or .env`);
  return value;
}

function stablePointId(articleId: string): string {
  const bytes = createHash("sha256")
    .update(`${collectionName}:${articleId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main() {
  const qdrant = new QdrantClient({
    url: requiredEnv("QDRANT_URL"),
    apiKey: requiredEnv("QDRANT_API_KEY"),
  });
  const articles = JSON.parse(
    await readFile(resolve(process.cwd(), "kb_articles.json"), "utf8"),
  ) as Article[];
  if (articles.length === 0) throw new Error("The KB article file is empty");

  if (await qdrant.collectionExists(collectionName).then((result) => result.exists)) {
    const collection = await qdrant.getCollection(collectionName);
    const vectors = collection.config.params.vectors;
    if (
      !vectors ||
      Array.isArray(vectors) ||
      vectors.size !== EMBEDDING_DIMENSIONS ||
      vectors.distance !== "Cosine"
    ) {
      throw new Error(
        `Existing collection ${collectionName} must use ${EMBEDDING_DIMENSIONS} dimensions and Cosine distance`,
      );
    }
  } else {
    await qdrant.createCollection(collectionName, {
      vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
    });
  }

  const vectors = await embedTexts(
    articles.map((article) => `${article.title}\n${article.content}`),
  );
  if (vectors.length !== articles.length) {
    throw new Error("Local embedding returned an unexpected number of article vectors");
  }

  await qdrant.upsert(collectionName, {
    wait: true,
    points: articles.map((article, index) => ({
      id: stablePointId(article.id),
      vector: vectors[index],
      payload: {
        articleId: article.id,
        title: article.title,
        category: article.category,
        content: article.content,
        stub: article.stub,
      },
    })),
  });

  console.log(`Upserted ${articles.length} articles into ${collectionName}.`);
  console.log(`Embedding model: ${EMBEDDING_MODEL}; distance: Cosine; dimensions: ${EMBEDDING_DIMENSIONS}.`);
}

main().catch((error: unknown) => {
  console.error("KB ingestion failed:", error);
  process.exitCode = 1;
});