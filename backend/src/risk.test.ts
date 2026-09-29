import { describe, expect, it } from "vitest";
import { detectKeywordRisk, getRiskSignalLabel } from "./risk.js";
import { MAX_ATTEMPTS, NodeFailure, runWithRetry } from "./retry.js";
import { createInitialState } from "./state.js";

describe("risk detection", () => {
  it.each([
    ["I received a phishing email", "Should I open it?"],
    ["Request admin access", "I need elevated access for a task."],
    ["Lost laptop", "My device was stolen on the bus."],
    ["Account activity", "I see unauthorized access on my account."],
  ])("flags security-sensitive tickets", (title, description) => {
    expect(detectKeywordRisk(title, description)).toBe(true);
  });

  it("does not flag an ordinary connectivity request", () => {
    expect(
      detectKeywordRisk("VPN will not connect", "My connection fails from home."),
    ).toBe(false);
  });

  it.each([
    [true, true, "both"],
    [true, false, "keyword"],
    [false, true, "llm"],
    [false, false, "neither"],
  ] as const)("labels risk signals", (keywordRisk, llmRisk, expected) => {
    expect(getRiskSignalLabel(keywordRisk, llmRisk)).toBe(expected);
  });
});

describe("node retries", () => {
  it("shares one four-attempt budget and records retry audit entries", async () => {
    const state = createInitialState({
      ticketId: "ticket-1",
      title: "WiFi",
      description: "Cannot connect",
    });
    let attempts = 0;
    const result = await runWithRetry(state, "classify", async () => {
      attempts += 1;
      throw new NodeFailure(
        attempts % 2 ? "api_error" : "invalid_output",
        "temporary failure",
      );
    });

    expect(MAX_ATTEMPTS).toBe(4);
    expect(attempts).toBe(4);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.retryCount.classify).toBe(4);
    expect(result.state.status).toBe("error");
    expect(result.state.auditLog.filter((entry) => entry.action === "retry")).toHaveLength(3);
    expect(result.state.auditLog.at(-1)?.action).toBe("node_failed_max_retries");
  });
});