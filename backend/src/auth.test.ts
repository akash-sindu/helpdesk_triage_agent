import { describe, expect, it } from "vitest";
import { hasValidApiKey } from "./auth.js";

describe("API key authorization", () => {
  it("accepts the configured key", () => {
    expect(hasValidApiKey("demo-key-123", "demo-key-123")).toBe(true);
  });

  it("rejects missing or incorrect keys", () => {
    expect(hasValidApiKey(undefined, "demo-key-123")).toBe(false);
    expect(hasValidApiKey("wrong-key", "demo-key-123")).toBe(false);
    expect(hasValidApiKey("demo-key-124", "demo-key-123")).toBe(false);
  });
});