import { describe, expect, it } from "vitest";
import {
  normalizeClassificationOutput,
  normalizeDraftOutput,
  unwrapStructuredOutput,
} from "./structured-output.js";

describe("Groq structured output normalization", () => {
  it("unwraps a valid JSON-mode raw message when schema parsing falls back", () => {
    expect(
      unwrapStructuredOutput({
        raw: { content: '{"answer":"Try the VPN guide","article_ids":["kb-002"]}' },
        parsed: null,
      }),
    ).toEqual({ answer: "Try the VPN guide", article_ids: ["kb-002"] });
  });

  it("normalizes GPT-OSS classifier field aliases", () => {
    expect(
      normalizeClassificationOutput({
        category: "Network & connectivity",
        highRisk: false,
        reasoning: "VPN connection issue.",
      }),
    ).toEqual({
      category: "Network & connectivity",
      isHighRisk: false,
      reasoning: "VPN connection issue.",
    });
  });

  it("normalizes GPT-OSS draft field aliases", () => {
    expect(
      normalizeDraftOutput({
        answer: "Try the VPN guide.",
        article_ids: ["kb-002"],
      }),
    ).toEqual({
      response: "Try the VPN guide.",
      citedArticleIds: ["kb-002"],
    });
  });
});