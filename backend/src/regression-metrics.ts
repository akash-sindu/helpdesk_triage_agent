export const REGRESSION_DIMENSIONS = [
  "category_match",
  "risk_match",
  "outcome_match",
  "citation_validity",
] as const;

export type RegressionDimension = (typeof REGRESSION_DIMENSIONS)[number];
export type EvaluationOutcome = "resolved" | "escalated";
export type RegressionStatus = "pass" | "warning" | "critical";

export interface CaseDimensions {
  category_match: number;
  risk_match: number;
  outcome_match: number;
  citation_validity: number | null;
}

export interface RegressionCase {
  id: string;
  expected_category: string;
  expected_is_high_risk: boolean;
  expected_outcome: EvaluationOutcome;
  expected_cited_article_ids: string[];
  difficulty: string;
  metrics: CaseDimensions;
  actual: {
    category: string | null;
    is_high_risk: boolean | null;
    outcome: EvaluationOutcome | null;
    cited_article_ids: string[];
    response: string | null;
    classify_error?: string;
    draft_error?: string;
  };
  latency_ms: { classify: number | null; draft: number | null };
  token_usage: {
    classify: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
    draft: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
  };
}

export interface RegressionSummary {
  casePassRate: number;
  dimensions: Record<RegressionDimension, number>;
  categoryAccuracy: Record<string, number>;
}

export interface EvalSnapshot {
  runId: string;
  generatedAt: string;
  model: string;
  promptVersions: { classify: string; draft: string };
  summary: RegressionSummary;
  cases: RegressionCase[];
}

export interface RegressionThresholds {
  warning: number;
  critical: number;
  driftFloor: number;
  riskDriftFloor: number;
}

export interface MetricDelta {
  previous: number;
  current: number;
  delta: number;
}

export interface RegressionComparison {
  status: RegressionStatus;
  previousRunId: string | null;
  deltas: Record<RegressionDimension | "overall", MetricDelta | null>;
  categoryDeltas: Record<string, MetricDelta>;
  regressions: string[];
  improvements: string[];
  riskRegressionIds: string[];
  drift: {
    runCount: number;
    averages: Record<RegressionDimension, number>;
    belowFloor: RegressionDimension[];
  };
}

export function summarizeCases(cases: RegressionCase[]): RegressionSummary {
  const dimensions = Object.fromEntries(
    REGRESSION_DIMENSIONS.map((dimension) => {
      const values = cases
        .map((testCase) => testCase.metrics[dimension])
        .filter((value): value is number => value !== null);
      return [
        dimension,
        values.length === 0
          ? 1
          : values.reduce((sum, value) => sum + value, 0) / values.length,
      ];
    }),
  ) as Record<RegressionDimension, number>;
  const categories = new Map<string, number[]>();
  for (const testCase of cases) {
    const values = categories.get(testCase.expected_category) ?? [];
    values.push(testCase.metrics.category_match);
    categories.set(testCase.expected_category, values);
  }
  const categoryAccuracy = Object.fromEntries(
    [...categories].map(([category, values]) => [
      category,
      values.reduce((sum, value) => sum + value, 0) / values.length,
    ]),
  );
  const totalWeight = cases.reduce(
    (sum, testCase) => sum + caseWeight(testCase),
    0,
  );
  const passedWeight = cases
    .filter(isPassingCase)
    .reduce((sum, testCase) => sum + caseWeight(testCase), 0);
  return {
    casePassRate: totalWeight === 0 ? 1 : passedWeight / totalWeight,
    dimensions,
    categoryAccuracy,
  };
}

function caseWeight(testCase: RegressionCase): number {
  switch (testCase.difficulty) {
    case "easy":
      return 2;
    case "risk":
      return 1.5;
    case "ambiguous":
    case "edge":
      return 0.75;
    default:
      return 1;
  }
}

function isPassingCase(testCase: RegressionCase): boolean {
  return REGRESSION_DIMENSIONS.every((dimension) => {
    const value = testCase.metrics[dimension];
    return value === null || value === 1;
  });
}

function metricDelta(previous: number, current: number): MetricDelta {
  return { previous, current, delta: current - previous };
}

export function compareRuns(
  current: EvalSnapshot,
  previous: EvalSnapshot | null,
  history: EvalSnapshot[],
  thresholds: RegressionThresholds,
): RegressionComparison {
  const dimensions = Object.fromEntries(
    REGRESSION_DIMENSIONS.map((dimension) => [
      dimension,
      previous
        ? metricDelta(
            previous.summary.dimensions[dimension],
            current.summary.dimensions[dimension],
          )
        : null,
    ]),
  ) as Record<RegressionDimension, MetricDelta | null>;
  const deltas: RegressionComparison["deltas"] = {
    ...dimensions,
    overall: previous
      ? metricDelta(previous.summary.casePassRate, current.summary.casePassRate)
      : null,
  };
  const categoryDeltas: Record<string, MetricDelta> = {};
  if (previous) {
    for (const [category, accuracy] of Object.entries(
      current.summary.categoryAccuracy,
    )) {
      if (previous.summary.categoryAccuracy[category] !== undefined) {
        categoryDeltas[category] = metricDelta(
          previous.summary.categoryAccuracy[category],
          accuracy,
        );
      }
    }
  }

  const oldCases = new Map(
    (previous?.cases ?? []).map((testCase) => [testCase.id, testCase]),
  );
  const regressions: string[] = [];
  const improvements: string[] = [];
  const riskRegressionIds: string[] = [];
  for (const testCase of current.cases) {
    const oldCase = oldCases.get(testCase.id);
    if (!oldCase) continue;
    const wasPassing = isPassingCase(oldCase);
    const isPassing = isPassingCase(testCase);
    if (wasPassing && !isPassing) regressions.push(testCase.id);
    if (!wasPassing && isPassing) improvements.push(testCase.id);
    if (
      testCase.expected_is_high_risk &&
      oldCase.metrics.risk_match === 1 &&
      testCase.metrics.risk_match === 0
    ) {
      riskRegressionIds.push(testCase.id);
    }
  }

  const runs = [...history, current].slice(-7);
  const averages = Object.fromEntries(
    REGRESSION_DIMENSIONS.map((dimension) => [
      dimension,
      runs.reduce((sum, run) => sum + run.summary.dimensions[dimension], 0) /
        Math.max(runs.length, 1),
    ]),
  ) as Record<RegressionDimension, number>;
  const belowFloor: RegressionDimension[] = [];
  if (runs.length >= 3) {
    for (const dimension of REGRESSION_DIMENSIONS) {
      const floor =
        dimension === "risk_match"
          ? thresholds.riskDriftFloor
          : thresholds.driftFloor;
      if (averages[dimension] < floor) belowFloor.push(dimension);
    }
  }

  let status: RegressionStatus = "pass";
  if (riskRegressionIds.length > 0) status = "critical";
  if (
    status === "pass" &&
    current.cases.some(
      (testCase) =>
        testCase.actual.classify_error || testCase.actual.draft_error,
    )
  ) {
    status = "warning";
  }
  const deltasToCheck = [
    ...Object.values(deltas).filter(
      (delta): delta is MetricDelta => delta !== null,
    ),
    ...Object.values(categoryDeltas),
  ];
  if (deltasToCheck.some((delta) => -delta.delta > thresholds.critical)) {
    status = "critical";
  } else if (
    status !== "critical" &&
    deltasToCheck.some((delta) => -delta.delta > thresholds.warning)
  ) {
    status = "warning";
  }
  if (status === "pass" && belowFloor.length > 0) status = "warning";

  return {
    status,
    previousRunId: previous?.runId ?? null,
    deltas,
    categoryDeltas,
    regressions,
    improvements,
    riskRegressionIds,
    drift: { runCount: runs.length, averages, belowFloor },
  };
}
