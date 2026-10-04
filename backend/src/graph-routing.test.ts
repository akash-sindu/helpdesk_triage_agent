import { describe, expect, it } from "vitest";
import { hasLowConfidenceMatch } from "./graph.js";

describe("low-confidence routing", () => {
  it("escalates missing and below-threshold matches but accepts the boundary", () => {
    expect(hasLowConfidenceMatch(null)).toBe(true);
    expect(hasLowConfidenceMatch(0.59)).toBe(true);
    expect(hasLowConfidenceMatch(0.6)).toBe(false);
  });
});
