type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapStructuredOutput(result: unknown): unknown {
  if (!isObject(result)) return result;

  if ("parsed" in result && isObject(result.parsed)) {
    return result.parsed;
  }

  const raw = result.raw;
  const content = isObject(raw) ? raw.content : undefined;
  if (typeof content === "string") {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  }

  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part): part is { text: string } =>
          isObject(part) && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return result.parsed ?? content ?? result;
}

export function normalizeClassificationOutput(value: unknown): unknown {
  if (!isObject(value)) return value;
  return {
    category: value.category,
    isHighRisk: value.isHighRisk ?? value.highRisk,
    reasoning: value.reasoning,
  };
}

export function normalizeDraftOutput(value: unknown): unknown {
  if (!isObject(value)) return value;
  return {
    response: value.response ?? value.answer,
    citedArticleIds:
      value.citedArticleIds ?? value.article_ids ?? value.articleIds,
  };
}