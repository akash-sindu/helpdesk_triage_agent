export interface BinaryMetricExample {
  expected: boolean;
  predicted: boolean | null;
}

export interface BinaryClassificationMetrics {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  support: number;
  unclassifiedPredictions: number;
  confusionMatrix: {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
  };
}

export interface MultiClassMetricExample {
  expected: string;
  predicted: string | null;
}

export interface ClassMetricValues {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface MultiClassClassificationMetrics {
  accuracy: number;
  support: number;
  perClass: Record<string, ClassMetricValues>;
  macroAverage: Omit<ClassMetricValues, "support">;
  weightedAverage: Omit<ClassMetricValues, "support">;
  confusionMatrix: {
    labels: string[];
    actualByPredicted: Record<string, Record<string, number>>;
  };
}

export interface ClassificationMetricExample {
  expected: {
    category?: string;
    highRisk?: boolean;
    escalation?: boolean;
  };
  actual: {
    category: string | null;
    isHighRisk: boolean | null;
    escalated: boolean;
  };
}

const UNCLASSIFIED = "(unclassified)";

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1Score(precision: number, recall: number): number {
  return divide(2 * precision * recall, precision + recall);
}

export function calculateBinaryMetrics(
  examples: BinaryMetricExample[],
): BinaryClassificationMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let unclassifiedPredictions = 0;

  for (const example of examples) {
    if (example.predicted === null) unclassifiedPredictions += 1;
    const predicted = example.predicted ?? false;
    if (example.expected && predicted) truePositive += 1;
    else if (!example.expected && predicted) falsePositive += 1;
    else if (!example.expected && !predicted) trueNegative += 1;
    else falseNegative += 1;
  }

  const precision = divide(truePositive, truePositive + falsePositive);
  const recall = divide(truePositive, truePositive + falseNegative);
  const support = examples.length;
  return {
    precision,
    recall,
    f1: f1Score(precision, recall),
    accuracy: divide(truePositive + trueNegative, support),
    support,
    unclassifiedPredictions,
    confusionMatrix: { truePositive, falsePositive, trueNegative, falseNegative },
  };
}

export function calculateMultiClassMetrics(
  examples: MultiClassMetricExample[],
  classLabels: string[],
): MultiClassClassificationMetrics {
  const labels = [...new Set([...classLabels, UNCLASSIFIED])];
  const matrix = Object.fromEntries(
    labels.map((actual) => [actual, Object.fromEntries(labels.map((predicted) => [predicted, 0]))]),
  );
  let correct = 0;

  for (const example of examples) {
    const actual = example.expected;
    const predicted = example.predicted ?? UNCLASSIFIED;
    if (!matrix[actual]) matrix[actual] = Object.fromEntries(labels.map((label) => [label, 0]));
    if (!(predicted in matrix[actual])) {
      for (const row of Object.values(matrix)) row[predicted] = 0;
      labels.push(predicted);
    }
    matrix[actual][predicted] += 1;
    if (actual === predicted) correct += 1;
  }

  const perClass: Record<string, ClassMetricValues> = {};
  for (const label of classLabels) {
    const truePositive = matrix[label]?.[label] ?? 0;
    const support = Object.values(matrix[label] ?? {}).reduce((total, count) => total + count, 0);
    const predictedCount = Object.values(matrix).reduce((total, row) => total + (row[label] ?? 0), 0);
    const precision = divide(truePositive, predictedCount);
    const recall = divide(truePositive, support);
    perClass[label] = { precision, recall, f1: f1Score(precision, recall), support };
  }

  const totalSupport = examples.length;
  const macroLabels = classLabels.filter((label) => {
    const support = Object.values(matrix[label] ?? {}).reduce((total, count) => total + count, 0);
    const predictedCount = Object.values(matrix).reduce((total, row) => total + (row[label] ?? 0), 0);
    return support > 0 || predictedCount > 0;
  });
  const macroAverage = {
    precision: divide(macroLabels.reduce((sum, label) => sum + perClass[label].precision, 0), macroLabels.length),
    recall: divide(macroLabels.reduce((sum, label) => sum + perClass[label].recall, 0), macroLabels.length),
    f1: divide(macroLabels.reduce((sum, label) => sum + perClass[label].f1, 0), macroLabels.length),
  };
  const weightedAverage = {
    precision: divide(Object.values(perClass).reduce((sum, item) => sum + item.precision * item.support, 0), totalSupport),
    recall: divide(Object.values(perClass).reduce((sum, item) => sum + item.recall * item.support, 0), totalSupport),
    f1: divide(Object.values(perClass).reduce((sum, item) => sum + item.f1 * item.support, 0), totalSupport),
  };

  return {
    accuracy: divide(correct, totalSupport),
    support: totalSupport,
    perClass,
    macroAverage,
    weightedAverage,
    confusionMatrix: { labels, actualByPredicted: matrix },
  };
}

export function calculateAgentClassificationMetrics(
  examples: ClassificationMetricExample[],
  categoryLabels: string[],
): {
  ticketCategory?: MultiClassClassificationMetrics;
  highRisk?: BinaryClassificationMetrics;
  escalation?: BinaryClassificationMetrics;
} {
  const categoryExamples = examples.flatMap(({ expected, actual }) =>
    expected.category === undefined ? [] : [{ expected: expected.category, predicted: actual.category }],
  );
  const riskExamples = examples.flatMap(({ expected, actual }) =>
    expected.highRisk === undefined ? [] : [{ expected: expected.highRisk, predicted: actual.isHighRisk }],
  );
  const escalationExamples = examples.flatMap(({ expected, actual }) =>
    expected.escalation === undefined ? [] : [{ expected: expected.escalation, predicted: actual.escalated }],
  );

  return {
    ...(categoryExamples.length > 0
      ? { ticketCategory: calculateMultiClassMetrics(categoryExamples, categoryLabels) }
      : {}),
    ...(riskExamples.length > 0 ? { highRisk: calculateBinaryMetrics(riskExamples) } : {}),
    ...(escalationExamples.length > 0 ? { escalation: calculateBinaryMetrics(escalationExamples) } : {}),
  };
}