import { CATEGORIES, type TriageState } from "./state.js";

export type EvaluationIssueCode =
  | "REDUNDANT_CALL"
  | "INVALID_NODE_ORDER"
  | "UNNECESSARY_TOOL_CALL"
  | "LOOP"
  | "MISSING_REQUIRED_NODE"
  | "INCORRECT_ROUTING"
  | "EXCESSIVE_RETRY"
  | "TOOL_CONTRACT_FAILURE"
  | "WORKFLOW_DID_NOT_TERMINATE";

export interface GoldenCase {
  id: string;
  title: string;
  description: string;
  expected: {
    category?: string;
    highRisk?: boolean;
    escalation?: boolean;
    status?: TriageState["status"];
    citedArticleIds?: string[];
    requiredNodes?: string[];
    forbiddenNodes?: string[];
    nodeOrder?: [string, string][];
    requiredTools?: string[];
    maxToolCalls?: number;
    maxCallsPerTool?: Record<string, number>;
    maxNodeExecutions?: number;
    shouldRetry?: boolean;
    responseShouldMention?: string[];
  };
  tags?: string[];
  faultInjection?: { tool: string; failAttempts: number };
}

export interface TraceStep {
  step: number;
  node: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface ToolCall {
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface AgentExecution {
  finalState: TriageState;
  trajectory: TraceStep[];
  toolCalls: ToolCall[];
  terminated: boolean;
}

export interface EvaluationIssue {
  code: EvaluationIssueCode;
  reason: string;
}

export interface EvaluationResult {
  test_case: string;
  level: 0 | 1 | 2;
  passed: boolean;
  score: number;
  criteria: Record<string, number>;
  reason: string;
  issues?: EvaluationIssue[];
}

export interface SemanticJudge {
  evaluateFinalOutput(input: {
    request: string;
    expected: GoldenCase["expected"];
    actual: Pick<TriageState, "category" | "isHighRisk" | "status" | "finalMessageToUser" | "retrievedArticles" | "retrievedArticleContent" | "citedArticleIds">;
  }): Promise<{ correctness: number; understanding: number; completeness: number; groundedness: number; reason: string }>;
  evaluateTrajectory(input: {
    request: string;
    expected: GoldenCase["expected"];
    trajectory: TraceStep[];
    toolCalls: ToolCall[];
  }): Promise<{ appropriateness: number; efficiency: number; reason: string }>;
  evaluateTool(input: {
    tool: string;
    request: string;
    expected: GoldenCase["expected"];
    output: unknown;
    availableArticles: TriageState["retrievedArticleContent"];
  }): Promise<{ score: number; reason: string }>;
}

type StreamableGraph = {
  stream(
    input: TriageState,
    options: { streamMode: "updates" },
  ): Promise<AsyncIterable<unknown>>;
};

function compactState(state: TriageState): Record<string, unknown> {
  return {
    ticketId: state.ticketId,
    title: state.title,
    description: state.description,
    category: state.category,
    isHighRisk: state.isHighRisk,
    status: state.status,
    retrievedArticleIds: state.retrievedArticles.map((article) => article.articleId),
    citedArticleIds: state.citedArticleIds,
    retryCount: state.retryCount,
    lastFailureReason: state.lastFailureReason,
    finalMessageToUser: state.finalMessageToUser,
  };
}

export async function captureGraphExecution(
  graph: StreamableGraph,
  initialState: TriageState,
  toolCalls: ToolCall[] = [],
): Promise<AgentExecution> {
  let current = initialState;
  const trajectory: TraceStep[] = [];

  const stream = await graph.stream(initialState, { streamMode: "updates" });
  for await (const update of stream) {
    if (!update || typeof update !== "object") continue;
    for (const [node, rawOutput] of Object.entries(update)) {
      if (!rawOutput || typeof rawOutput !== "object") continue;
      const output = rawOutput as Record<string, unknown>;
      trajectory.push({
        step: trajectory.length + 1,
        node,
        input: compactState(current),
        output,
      });
      current = { ...current, ...output };
    }
  }

  const finalState = current as TriageState;
  return {
    finalState,
    trajectory,
    toolCalls,
    terminated: trajectory.some((step) => step.node === "persist"),
  };
}

function mean(values: number[]): number {
  return values.length === 0
    ? 1
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function evaluateLevel0(
  testCase: GoldenCase,
  state: TriageState,
  judge?: SemanticJudge,
): Promise<EvaluationResult> {
  const checks: Record<string, number> = {};
  const expected = testCase.expected;
  if (expected.category !== undefined) checks.classification = Number(state.category === expected.category);
  if (expected.highRisk !== undefined) checks.risk = Number(state.isHighRisk === expected.highRisk);
  if (expected.status !== undefined) checks.outcome = Number(state.status === expected.status);
  checks.response_present = Number(Boolean(state.finalMessageToUser?.trim()));
  checks.citations_valid = Number(
    state.citedArticleIds.every((id) => state.retrievedArticles.some((article) => article.articleId === id)),
  );
  if (expected.citedArticleIds) {
    checks.expected_citations = Number(expected.citedArticleIds.every((id) => state.citedArticleIds.includes(id)));
  }
  if (expected.responseShouldMention) {
    const response = (state.finalMessageToUser ?? "").toLowerCase();
    checks.required_information = mean(expected.responseShouldMention.map((phrase) => Number(response.includes(phrase.toLowerCase()))));
  }

  let reason = "Deterministic outcome and response-contract checks completed.";
  if (judge) {
    const semantic = await judge.evaluateFinalOutput({
      request: `${testCase.title}\n${testCase.description}`,
      expected,
      actual: {
        category: state.category,
        isHighRisk: state.isHighRisk,
        status: state.status,
        finalMessageToUser: state.finalMessageToUser,
        retrievedArticles: state.retrievedArticles,
        retrievedArticleContent: state.retrievedArticleContent,
        citedArticleIds: state.citedArticleIds,
      },
    });
    Object.assign(checks, {
      correctness: semantic.correctness,
      understanding: semantic.understanding,
      completeness: semantic.completeness,
      groundedness: semantic.groundedness,
    });
    reason = semantic.reason;
  }

  const score = mean(Object.values(checks));
  return {
    test_case: testCase.id,
    level: 0,
    passed: score >= 0.8 && Object.values(checks).every((value) => value >= 0.5),
    score,
    criteria: checks,
    reason,
  };
}

export async function evaluateLevel1(
  testCase: GoldenCase,
  execution: AgentExecution,
  judge?: SemanticJudge,
): Promise<EvaluationResult> {
  const expected = testCase.expected;
  const nodes = execution.trajectory.map((step) => step.node);
  const issues: EvaluationIssue[] = [];
  for (const node of expected.requiredNodes ?? []) {
    if (!nodes.includes(node)) issues.push({ code: "MISSING_REQUIRED_NODE", reason: `Required node '${node}' did not execute.` });
  }
  for (const node of expected.forbiddenNodes ?? []) {
    if (nodes.includes(node)) issues.push({ code: "UNNECESSARY_TOOL_CALL", reason: `Forbidden node '${node}' executed.` });
  }
  for (const [before, after] of expected.nodeOrder ?? []) {
    const beforeIndex = nodes.indexOf(before);
    const afterIndex = nodes.indexOf(after);
    if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
      issues.push({ code: "INVALID_NODE_ORDER", reason: `Expected '${before}' before '${after}'.` });
    }
  }
  if (expected.highRisk === true && (!nodes.includes("escalate") || nodes.includes("retrieve"))) {
    issues.push({ code: "INCORRECT_ROUTING", reason: "High-risk requests must escalate before retrieval." });
  }
  if (expected.highRisk === false && expected.status === "resolved" && (!nodes.includes("retrieve") || !nodes.includes("draft"))) {
    issues.push({ code: "INCORRECT_ROUTING", reason: "A non-risk request expected to resolve must retrieve evidence and draft a response." });
  }
  if (expected.shouldRetry !== undefined) {
    const retried = execution.finalState.auditLog.some((entry) => entry.action === "retry");
    if (retried !== expected.shouldRetry) {
      issues.push({ code: "EXCESSIVE_RETRY", reason: `Expected retry=${expected.shouldRetry}, observed retry=${retried}.` });
    }
  }
  if (!execution.terminated) {
    issues.push({ code: "WORKFLOW_DID_NOT_TERMINATE", reason: "The graph did not reach the persist/terminal step." });
  }
  if (expected.maxNodeExecutions !== undefined && execution.trajectory.length > expected.maxNodeExecutions) {
    issues.push({ code: "LOOP", reason: `Observed ${execution.trajectory.length} node executions; maximum is ${expected.maxNodeExecutions}.` });
  }
  if (expected.maxToolCalls !== undefined && execution.toolCalls.length > expected.maxToolCalls) {
    issues.push({ code: "REDUNDANT_CALL", reason: `Observed ${execution.toolCalls.length} tool calls; maximum is ${expected.maxToolCalls}.` });
  }
  for (const [tool, maximum] of Object.entries(expected.maxCallsPerTool ?? {})) {
    const actual = execution.toolCalls.filter((call) => call.tool === tool).length;
    if (actual > maximum) issues.push({ code: "EXCESSIVE_RETRY", reason: `Tool '${tool}' ran ${actual} times; maximum is ${maximum}.` });
  }
  for (const tool of expected.requiredTools ?? []) {
    if (!execution.toolCalls.some((call) => call.tool === tool)) {
      issues.push({ code: "MISSING_REQUIRED_NODE", reason: `Required tool '${tool}' was not called.` });
    }
  }
  const repeatedCall = execution.toolCalls.some((call, index) =>
    !call.error && execution.toolCalls.slice(0, index).some((previous) =>
      !previous.error && previous.tool === call.tool && JSON.stringify(previous.input) === JSON.stringify(call.input),
    ),
  );
  if (repeatedCall) issues.push({ code: "REDUNDANT_CALL", reason: "A tool was called repeatedly with identical arguments." });

  const criteria: Record<string, number> = {
    required_nodes: Number(!issues.some((issue) => issue.code === "MISSING_REQUIRED_NODE")),
    node_order: Number(!issues.some((issue) => issue.code === "INVALID_NODE_ORDER")),
    routing: Number(!issues.some((issue) => issue.code === "INCORRECT_ROUTING")),
    no_loops: Number(!issues.some((issue) => issue.code === "LOOP" || issue.code === "REDUNDANT_CALL")),
    termination: Number(execution.terminated),
  };
  let reason = issues.length ? issues.map((issue) => `${issue.code}: ${issue.reason}`).join(" ") : "Trajectory satisfied deterministic route and efficiency assertions.";
  if (judge) {
    const semantic = await judge.evaluateTrajectory({
      request: `${testCase.title}\n${testCase.description}`,
      expected,
      trajectory: execution.trajectory,
      toolCalls: execution.toolCalls,
    });
    criteria.semantic_appropriateness = semantic.appropriateness;
    criteria.efficiency = semantic.efficiency;
    if (issues.length === 0) reason = semantic.reason;
  }
  const score = mean(Object.values(criteria));
  return { test_case: testCase.id, level: 1, passed: issues.length === 0 && score >= 0.8, score, criteria, reason, issues };
}

export async function evaluateToolContracts(
  testCase: GoldenCase,
  execution: AgentExecution,
  judge?: SemanticJudge,
): Promise<EvaluationResult> {
  const issues: EvaluationIssue[] = [];
  for (const call of execution.toolCalls) {
    if (call.error) continue;
    if (call.tool === "classify" && (!call.output || typeof call.output !== "object" || !CATEGORIES.includes((call.output as Record<string, unknown>).category as (typeof CATEGORIES)[number]) || typeof (call.output as Record<string, unknown>).isHighRisk !== "boolean")) {
      issues.push({ code: "TOOL_CONTRACT_FAILURE", reason: "Classifier output must include category and boolean isHighRisk." });
    }
    if (call.tool === "embedQuery" && (!Array.isArray(call.output) || call.output.length !== 384 || call.output.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
      issues.push({ code: "TOOL_CONTRACT_FAILURE", reason: "Embedding output must be a 384-dimensional numeric vector." });
    }
    if (call.tool === "qdrant.query" && (!Array.isArray(call.output) || call.output.some((point) => {
      if (!point || typeof point !== "object") return true;
      const result = point as { score?: unknown; payload?: unknown };
      const payload = result.payload;
      return typeof result.score !== "number" || !Number.isFinite(result.score) || !payload || typeof payload !== "object" ||
        typeof (payload as Record<string, unknown>).articleId !== "string" ||
        typeof (payload as Record<string, unknown>).title !== "string" ||
        typeof (payload as Record<string, unknown>).content !== "string";
    }))) {
      issues.push({ code: "TOOL_CONTRACT_FAILURE", reason: "Qdrant results must include numeric scores and articleId/title/content payloads." });
    }
    if (call.tool === "draft") {
      const output = call.output as { response?: unknown; citedArticleIds?: unknown } | undefined;
      const retrievedIds = new Set(execution.finalState.retrievedArticles.map((article) => article.articleId));
      if (!output || typeof output.response !== "string" || !output.response.trim() ||
        !Array.isArray(output.citedArticleIds) || output.citedArticleIds.length === 0 ||
        output.citedArticleIds.some((id) => typeof id !== "string" || !retrievedIds.has(id))) {
        issues.push({ code: "TOOL_CONTRACT_FAILURE", reason: "Draft output must include a non-empty response and citations limited to retrieved article IDs." });
      }
    }
  }
  const criteria: Record<string, number> = { tool_contracts: issues.length === 0 ? 1 : 0 };
  let reason = issues.length ? issues.map((issue) => issue.reason).join(" ") : "All observed tool outputs satisfied their contracts.";
  if (judge) {
    const semanticCalls = execution.toolCalls.filter((call) =>
      (call.tool === "classify" || call.tool === "draft") && call.output !== undefined,
    );
    const scores: number[] = [];
    for (const call of semanticCalls) {
      const assessment = await judge.evaluateTool({
        tool: call.tool,
        request: `${testCase.title}\n${testCase.description}`,
        expected: testCase.expected,
        output: call.output,
        availableArticles: execution.finalState.retrievedArticleContent,
      });
      scores.push(assessment.score);
      if (assessment.score < 0.7) {
        issues.push({ code: "TOOL_CONTRACT_FAILURE", reason: `${call.tool} semantic evaluation: ${assessment.reason}` });
      }
    }
    if (scores.length) {
      criteria.semantic_tool_quality = mean(scores);
      reason = issues.length ? issues.map((issue) => issue.reason).join(" ") : "Tool contracts and semantic tool quality passed.";
    }
  }
  criteria.tool_contracts = Number(!issues.some((issue) => issue.code === "TOOL_CONTRACT_FAILURE"));
  return {
    test_case: testCase.id,
    level: 2,
    passed: issues.length === 0,
    score: mean(Object.values(criteria)),
    criteria,
    reason,
    issues,
  };
}