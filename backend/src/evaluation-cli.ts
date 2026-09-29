import { writeFile } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import { ChatGroq } from "@langchain/groq";
import { QdrantClient } from "@qdrant/js-client-rest";
import casesJson from "./evaluation-cases.json" with { type: "json" };
import type { GoldenCase } from "./evaluation.js";
import { createJudgeIfEnabled, runEvaluation } from "./evaluation-runner.js";
import type { BinaryClassificationMetrics, MultiClassClassificationMetrics } from "./classification-metrics.js";

loadEnv({ path: process.env.DOTENV_CONFIG_PATH ?? "../.env" });

const args = process.argv.slice(2);
function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function selectedCases(allCases: GoldenCase[]): GoldenCase[] {
  const selectedId = argument("--case");
  const filter = argument("--filter");
  return allCases.filter((testCase) =>
    (!selectedId || testCase.id === selectedId) &&
    (!filter || testCase.tags?.includes(filter)),
  );
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printBinaryMetrics(label: string, metrics: BinaryClassificationMetrics | undefined): void {
  if (!metrics) return;
  const { truePositive, falsePositive, trueNegative, falseNegative } = metrics.confusionMatrix;
  console.log(`\n${label} (support: ${metrics.support})`);
  console.log(`Precision: ${percentage(metrics.precision)}`);
  console.log(`Recall: ${percentage(metrics.recall)}`);
  console.log(`F1: ${percentage(metrics.f1)}`);
  console.log(`Accuracy: ${percentage(metrics.accuracy)}`);
  console.log(`TP: ${truePositive}  FP: ${falsePositive}  TN: ${trueNegative}  FN: ${falseNegative}`);
  if (metrics.unclassifiedPredictions > 0) {
    console.log(`Unclassified predictions: ${metrics.unclassifiedPredictions} (counted as negative)`);
  }
}

function printCategoryMetrics(metrics: MultiClassClassificationMetrics | undefined): void {
  if (!metrics) return;
  console.log(`\nTicket Category (support: ${metrics.support})`);
  console.log(`Accuracy: ${percentage(metrics.accuracy)}`);
  console.log(`Macro Precision: ${percentage(metrics.macroAverage.precision)}`);
  console.log(`Macro Recall: ${percentage(metrics.macroAverage.recall)}`);
  console.log(`Macro F1: ${percentage(metrics.macroAverage.f1)}`);
  console.log(`Weighted Precision: ${percentage(metrics.weightedAverage.precision)}`);
  console.log(`Weighted Recall: ${percentage(metrics.weightedAverage.recall)}`);
  console.log(`Weighted F1: ${percentage(metrics.weightedAverage.f1)}`);
  console.log("Per-class:");
  for (const [category, scores] of Object.entries(metrics.perClass)) {
    console.log(`  ${category}: P ${percentage(scores.precision)}  R ${percentage(scores.recall)}  F1 ${percentage(scores.f1)}  support ${scores.support}`);
  }

  const labels = metrics.confusionMatrix.labels;
  const width = Math.max(13, ...labels.map((label) => label.length));
  console.log("Confusion matrix (actual rows, predicted columns):");
  console.log(`${"Actual \\ Predicted".padEnd(width)} ${labels.map((label) => label.padStart(width)).join(" ")}`);
  for (const actual of labels) {
    const values = labels.map((predicted) => String(metrics.confusionMatrix.actualByPredicted[actual]?.[predicted] ?? 0).padStart(width));
    console.log(`${actual.padEnd(width)} ${values.join(" ")}`);
  }
}

function printReport(report: Awaited<ReturnType<typeof runEvaluation>>): void {
  console.log("CLASSIFICATION EVALUATION");
  console.log("=========================");
  printCategoryMetrics(report.summary.classificationMetrics.ticketCategory);
  printBinaryMetrics("High-risk classification", report.summary.classificationMetrics.highRisk);
  printBinaryMetrics("Escalation decision", report.summary.classificationMetrics.escalation);
  console.log("\nPriority/severity and team assignment are not reported: the current agent does not output those labels.");

  console.log("\nHELPDESK AGENT EVALUATION");
  console.log("==========================");
  for (const [level, result] of Object.entries(report.summary.byLevel)) {
    const label = level.replace("level", "Level ");
    console.log(`${label}: ${result.passed}/${result.total} (${(result.passRate * 100).toFixed(1)}%)`);
  }
  console.log(`\nOverall: ${report.summary.passed}/${report.summary.passed + report.summary.failed} checks passed across ${report.summary.testCases} test cases.`);
  for (const testCase of report.cases) {
    for (const result of testCase.results.filter((entry) => !entry.passed)) {
      console.log(`\nFAIL: ${testCase.id}\nLevel: ${result.level}\nReason: ${result.reason}`);
      for (const issue of result.issues ?? []) console.log(`Issue: ${issue.code} - ${issue.reason}`);
      if (result.level === 1) {
        console.log(`Expected nodes: ${JSON.stringify(testCase.expected.requiredNodes ?? [])}`);
        console.log(`Actual nodes: ${JSON.stringify(testCase.execution.trajectory.map((step) => step.node))}`);
      }
    }
  }
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY;
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  const collectionName = process.env.QDRANT_COLLECTION;
  const modelName = process.env.GROQ_CHAT_MODEL;
  if (!apiKey || !qdrantUrl || !qdrantApiKey || !collectionName || !modelName) {
    throw new Error("Set GROQ_API_KEY, QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION, and GROQ_CHAT_MODEL before evaluation.");
  }
  const model = new ChatGroq({ apiKey, model: modelName, temperature: 0, maxRetries: 0, timeout: 12000 });
  const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });
  const cases = selectedCases(casesJson as GoldenCase[]);
  if (cases.length === 0) throw new Error("No golden cases matched the requested selection.");
  const requestedLevel = argument("--level");
  const levels = requestedLevel ? [Number(requestedLevel)] : [0, 1, 2];
  if (levels.some((level) => ![0, 1, 2].includes(level))) throw new Error("--level must be 0, 1, or 2.");
  const judge = createJudgeIfEnabled(model, process.env.EVAL_ENABLE_LLM_JUDGE === "true");
  const report = await runEvaluation(cases, {
    levels,
    judge,
    model,
    qdrant,
    collectionName,
  });
  printReport(report);
  const outputPath = argument("--output");
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});