import { describe, expect, it } from "vitest";
import {
  compareRuns,
  summarizeCases,
  type EvalSnapshot,
  type RegressionCase,
  type RegressionThresholds,
} from "./regression-metrics.js";

const thresholds: RegressionThresholds = {
  warning: 0.03,
  critical: 0.08,
  driftFloor: 0.9,
  riskDriftFloor: 0.98,
};

function testCase(
  id: string,
  values: { category?: number; risk?: number; outcome?: number },
  highRisk = false,
): RegressionCase {
  return {
    id,
    expected_category: "Account & access",
    expected_is_high_risk: highRisk,
    expected_outcome: "resolved",
    expected_cited_article_ids: ["kb-022"],
    difficulty: "easy",
    metrics: {
      category_match: values.category ?? 1,
      risk_match: values.risk ?? 1,
      outcome_match: values.outcome ?? 1,
      citation_validity: 1,
    },
    actual: {
      category: "Account & access",
      is_high_risk: highRisk,
      outcome: "resolved",
      cited_article_ids: ["kb-022"],
      response: "Try the approved steps.",
    },
    latency_ms: { classify: 20, draft: 30 },
    token_usage: { classify: null, draft: null },
  };
}

function snapshot(runId: string, cases: RegressionCase[]): EvalSnapshot {
  return {
    runId,
    generatedAt: "2026-10-01T00:00:00.000Z",
    model: "test-model",
    promptVersions: { classify: "v1", draft: "v1" },
    summary: summarizeCases(cases),
    cases,
  };
}

describe("regression metrics", () => {
  it("weights easy-case failures more heavily than ambiguous-case failures", () => {
    const easyFailure = testCase("easy-failure", { category: 0 });
    const ambiguousFailure = {
      ...testCase("ambiguous-failure", { category: 0 }),
      difficulty: "ambiguous",
    };
    const mediumPass = { ...testCase("medium-pass", {}), difficulty: "medium" };

    expect(summarizeCases([mediumPass, easyFailure]).casePassRate).toBeCloseTo(1 / 3);
    expect(summarizeCases([mediumPass, ambiguousFailure]).casePassRate).toBeCloseTo(1 / 1.75);
  });

  it("marks any risk-case false negative as critical", () => {
    const previous = snapshot("old", [testCase("risk-1", {}, true)]);
    const current = snapshot("new", [testCase("risk-1", { risk: 0 }, true)]);
    const comparison = compareRuns(current, previous, [previous], thresholds);

    expect(comparison.status).toBe("critical");
    expect(comparison.riskRegressionIds).toEqual(["risk-1"]);
    expect(comparison.regressions).toEqual(["risk-1"]);
  });

  it("distinguishes overall flips and dimension deltas", () => {
    const previous = snapshot("old", [
      testCase("case-1", { category: 0 }),
      testCase("case-2", {}),
    ]);
    const current = snapshot("new", [testCase("case-1", {}), testCase("case-2", {})]);
    const comparison = compareRuns(current, previous, [previous], thresholds);

    expect(comparison.improvements).toEqual(["case-1"]);
    expect(comparison.deltas.category_match?.delta).toBe(0.5);
  });

  it("warns when the rolling dimension average falls below its floor", () => {
    const history = [
      snapshot("one", [testCase("risk-1", { risk: 0 }, true)]),
      snapshot("two", [testCase("risk-1", { risk: 0 }, true)]),
    ];
    const current = snapshot("three", [testCase("risk-1", {}, true)]);
    const comparison = compareRuns(current, history[1], history, thresholds);

    expect(comparison.status).toBe("warning");
    expect(comparison.drift.belowFloor).toContain("risk_match");
  });
});