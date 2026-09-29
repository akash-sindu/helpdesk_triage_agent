import { describe, expect, it } from "vitest";
import casesJson from "./evaluation-cases.json" with { type: "json" };
import {
  captureGraphExecution,
  evaluateLevel0,
  evaluateLevel1,
  evaluateToolContracts,
  type AgentExecution,
  type GoldenCase,
} from "./evaluation.js";
import { createInitialState, type TriageState } from "./state.js";

const cases = casesJson as GoldenCase[];

function completedState(overrides: Partial<TriageState> = {}): TriageState {
  return {
    ...createInitialState({ ticketId: "eval-test", title: "VPN", description: "VPN does not connect" }),
    category: "Network & connectivity",
    isHighRisk: false,
    status: "resolved",
    finalMessageToUser: "Restart the VPN client and confirm your home internet is working.",
    retrievedArticles: [{ articleId: "kb-002", title: "VPN troubleshooting", score: 0.9 }],
    retrievedArticleContent: [{ articleId: "kb-002", title: "VPN troubleshooting", content: "Restart the VPN client." }],
    citedArticleIds: ["kb-002"],
    ...overrides,
  };
}

function execution(nodes: string[], state = completedState()): AgentExecution {
  return {
    finalState: state,
    trajectory: nodes.map((node, index) => ({
      step: index + 1,
      node,
      input: {},
      output: {},
    })),
    toolCalls: [],
    terminated: nodes.includes("persist"),
  };
}

describe("golden evaluation dataset", () => {
  it("has unique IDs and includes a fault-injected retry case", () => {
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.some((testCase) => testCase.faultInjection?.tool === "qdrant.query")).toBe(true);
  });
});

describe("Level 0 output evaluation", () => {
  it("passes deterministic category, risk, status, content, and citation checks", async () => {
    const testCase: GoldenCase = {
      id: "vpn_test",
      title: "VPN",
      description: "VPN does not connect",
      expected: {
        category: "Network & connectivity",
        highRisk: false,
        status: "resolved",
        citedArticleIds: ["kb-002"],
        responseShouldMention: ["vpn"],
      },
    };
    const result = await evaluateLevel0(testCase, completedState());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("fails when a cited article was not retrieved", async () => {
    const testCase: GoldenCase = { id: "citation_test", title: "VPN", description: "Help", expected: {} };
    const state = completedState({ citedArticleIds: ["kb-unknown"] });
    const result = await evaluateLevel0(testCase, state);
    expect(result.passed).toBe(false);
    expect(result.criteria.citations_valid).toBe(0);
  });
});

describe("Level 1 trajectory evaluation", () => {
  it("accepts a valid route without requiring a single exact trace", async () => {
    const testCase: GoldenCase = {
      id: "route_test",
      title: "VPN",
      description: "Help",
      expected: {
        highRisk: false,
        status: "resolved",
        requiredNodes: ["classify", "retrieve", "draft", "persist"],
        nodeOrder: [["classify", "retrieve"], ["retrieve", "draft"]],
      },
    };
    const result = await evaluateLevel1(testCase, execution(["classify", "retrieve", "draft", "persist"]));
    expect(result.passed).toBe(true);
  });

  it("reports incorrect security routing and repeated tool calls", async () => {
    const testCase: GoldenCase = {
      id: "risk_route_test",
      title: "Phishing",
      description: "Suspicious email",
      expected: { highRisk: true, requiredNodes: ["classify", "escalate", "persist"] },
    };
    const run = execution(["classify", "retrieve", "persist"], completedState({ isHighRisk: true }));
    run.toolCalls = [
      { tool: "qdrant.query", input: { limit: 3 } },
      { tool: "qdrant.query", input: { limit: 3 } },
    ];
    const result = await evaluateLevel1(testCase, run);
    expect(result.passed).toBe(false);
    expect(result.issues?.map((issue) => issue.code)).toContain("INCORRECT_ROUTING");
    expect(result.issues?.map((issue) => issue.code)).toContain("REDUNDANT_CALL");
  });

  it("does not treat identical failed retries as redundant calls", async () => {
    const testCase: GoldenCase = {
      id: "retry_test",
      title: "VPN",
      description: "Help",
      expected: { shouldRetry: true, maxCallsPerTool: { "qdrant.query": 4 } },
    };
    const state = completedState({
      auditLog: [
        ...completedState().auditLog,
        { timestamp: "now", node: "retrieve", action: "retry", detail: {} },
      ],
    });
    const run = execution(["classify", "retrieve", "retrieve", "persist"], state);
    run.toolCalls = Array.from({ length: 4 }, (_, index) => ({
      tool: "qdrant.query",
      input: { limit: 3 },
      ...(index < 3 ? { error: "temporary outage" } : { output: [] }),
    }));
    const result = await evaluateLevel1(testCase, run);
    expect(result.passed).toBe(true);
    expect(result.issues?.some((issue) => issue.code === "REDUNDANT_CALL")).toBe(false);
  });

  it("captures ordered node updates and merges final state", async () => {
    const initialState = createInitialState({ ticketId: "trace-test", title: "VPN", description: "Help" });
    const graph = {
      async stream() {
        return (async function* () {
          yield { classify: { category: "Network & connectivity", isHighRisk: false } };
          yield { persist: { status: "resolved" } };
        })();
      },
    };
    const result = await captureGraphExecution(graph, initialState);
    expect(result.trajectory.map((step) => step.node)).toEqual(["classify", "persist"]);
    expect(result.finalState.category).toBe("Network & connectivity");
    expect(result.terminated).toBe(true);
  });
});

describe("Level 2 tool contracts", () => {
  it("rejects malformed embedding results", async () => {
    const testCase: GoldenCase = { id: "bad_embedding", title: "x", description: "y", expected: {} };
    const run = execution(["persist"]);
    run.toolCalls = [{ tool: "embedQuery", input: "query", output: [0.1, 0.2] }];
    const result = await evaluateToolContracts(testCase, run);
    expect(result.passed).toBe(false);
    expect(result.issues?.[0]?.code).toBe("TOOL_CONTRACT_FAILURE");
  });

  it("accepts a valid classifier and draft contract", async () => {
    const testCase: GoldenCase = { id: "valid_tools", title: "x", description: "y", expected: {} };
    const run = execution(["classify", "draft", "persist"]);
    run.toolCalls = [
      { tool: "classify", input: {}, output: { category: "Hardware", isHighRisk: false, reasoning: "Device issue" } },
      { tool: "draft", input: {}, output: { response: "Try this", citedArticleIds: ["kb-002"] } },
    ];
    const result = await evaluateToolContracts(testCase, run);
    expect(result.passed).toBe(true);
  });
});