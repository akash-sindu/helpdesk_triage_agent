import { describe, expect, it } from "vitest";
import {
  calculateAgentClassificationMetrics,
  calculateBinaryMetrics,
  calculateMultiClassMetrics,
} from "./classification-metrics.js";

describe("binary classification metrics", () => {
  it("calculates precision, recall, F1, support, and confusion counts", () => {
    const result = calculateBinaryMetrics([
      { expected: true, predicted: true },
      { expected: true, predicted: false },
      { expected: false, predicted: true },
      { expected: false, predicted: false },
    ]);
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(0.5);
    expect(result.f1).toBe(0.5);
    expect(result.accuracy).toBe(0.5);
    expect(result.support).toBe(4);
    expect(result.confusionMatrix).toEqual({ truePositive: 1, falsePositive: 1, trueNegative: 1, falseNegative: 1 });
  });

  it("returns zero for undefined precision, recall, and F1", () => {
    const result = calculateBinaryMetrics([{ expected: false, predicted: false }]);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
    expect(result.support).toBe(1);
  });

  it("counts missing predictions as negative and reports them", () => {
    const result = calculateBinaryMetrics([{ expected: true, predicted: null }]);
    expect(result.confusionMatrix.falseNegative).toBe(1);
    expect(result.unclassifiedPredictions).toBe(1);
  });
});

describe("multi-class classification metrics", () => {
  it("calculates per-class metrics, averages, and an actual-by-predicted matrix", () => {
    const result = calculateMultiClassMetrics([
      { expected: "Access", predicted: "Access" },
      { expected: "Access", predicted: "Technical" },
      { expected: "Technical", predicted: "Technical" },
    ], ["Access", "Technical"]);
    expect(result.accuracy).toBeCloseTo(2 / 3);
    expect(result.perClass.Access).toEqual({ precision: 1, recall: 0.5, f1: 2 / 3, support: 2 });
    expect(result.confusionMatrix.actualByPredicted.Access.Access).toBe(1);
    expect(result.confusionMatrix.actualByPredicted.Access.Technical).toBe(1);
    expect(result.macroAverage.f1).toBeCloseTo((2 / 3 + 2 / 3) / 2);
  });

  it("tracks missing category predictions as an unclassified confusion column", () => {
    const result = calculateMultiClassMetrics([{ expected: "Access", predicted: null }], ["Access"]);
    expect(result.perClass.Access.recall).toBe(0);
    expect(result.confusionMatrix.actualByPredicted.Access["(unclassified)"]).toBe(1);
  });

  it("does not dilute a filtered report with absent categories", () => {
    const result = calculateMultiClassMetrics([{ expected: "Access", predicted: "Access" }], ["Access", "Hardware"]);
    expect(result.macroAverage.f1).toBe(1);
    expect(result.perClass.Hardware.support).toBe(0);
  });
});

describe("agent decision metric aggregation", () => {
  it("skips cases without explicit golden labels", () => {
    const result = calculateAgentClassificationMetrics([
      {
        expected: { category: "Access", escalation: true },
        actual: { category: "Access", isHighRisk: null, escalated: false },
      },
      {
        expected: {},
        actual: { category: "Hardware", isHighRisk: false, escalated: true },
      },
    ], ["Access", "Hardware"]);
    expect(result.ticketCategory?.support).toBe(1);
    expect(result.escalation?.support).toBe(1);
    expect(result.highRisk).toBeUndefined();
    expect(result.escalation?.confusionMatrix.falseNegative).toBe(1);
  });
});