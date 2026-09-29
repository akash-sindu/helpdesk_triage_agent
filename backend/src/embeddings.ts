import { homedir } from "node:os";
import { resolve } from "node:path";
import { env, pipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_COLLECTION_NAME = "helpdesk-kb";

env.cacheDir =
  process.env.TRANSFORMERS_CACHE_DIR ??
  resolve(homedir(), ".cache", "helpdesk-triage");

type EmbeddingTensor = { tolist: () => unknown };
type FeatureExtractor = (
  texts: string | string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<EmbeddingTensor>;

let extractorPromise: Promise<FeatureExtractor> | undefined;

function getExtractor() {
  extractorPromise ??= pipeline("feature-extraction", EMBEDDING_MODEL, {
    dtype: "q8",
  }).then((extractor) => extractor as unknown as FeatureExtractor);
  return extractorPromise;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const embeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += 16) {
    const batch = texts.slice(offset, offset + 16);
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    const result = tensor.tolist();
    if (!Array.isArray(result) || result.length !== batch.length) {
      throw new Error(
        "Local embedding model returned an unexpected batch shape",
      );
    }
    for (const embedding of result) {
      if (
        !Array.isArray(embedding) ||
        embedding.length !== EMBEDDING_DIMENSIONS ||
        embedding.some((value) => typeof value !== "number")
      ) {
        throw new Error("Local embedding model returned an invalid vector");
      }
      embeddings.push(embedding as number[]);
    }
  }
  return embeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  if (!embedding) throw new Error("Local embedding model returned no vector");
  return embedding;
}
