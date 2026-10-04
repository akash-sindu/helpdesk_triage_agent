import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { config as loadEnv } from "dotenv";
import { createChatModel } from "../../backend/src/chat-model.js";
import { CATEGORIES } from "../../backend/src/state.js";
import {
  classifyTicket,
  draftTicketResponse,
  hasLowConfidenceMatch,
} from "../../backend/src/graph.js";
import {
  compareRuns,
  summarizeCases,
  type EvalSnapshot,
  type RegressionCase,
  type RegressionComparison,
  type RegressionDimension,
  type RegressionThresholds,
} from "../../backend/src/regression-metrics.js";
import { buildHtmlReport } from "./report.js";

loadEnv({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });

const ROOT = process.cwd();
const CONFIDENCE_THRESHOLD = 0.6;

interface GoldenInput {
  id: string;
  title: string;
  description: string;
  expected_category: string;
  expected_is_high_risk: boolean;
  expected_outcome: "resolved" | "escalated";
  expected_cited_article_ids: string[];
  retrieval_score: number | null;
  difficulty: string;
  notes: string;
}

interface DatasetFile {
  version: string;
  cases: GoldenInput[];
}

interface KnowledgeArticle {
  id: string;
  category: string;
  title: string;
  content: string;
}

interface PromptFile {
  version: string;
}

interface RunSummary {
  status: RegressionComparison["status"];
  current: EvalSnapshot["summary"];
  comparison: RegressionComparison;
  runId: string;
  reportPath: string;
  reportUrl: string;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function envThreshold(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `${name} must be a decimal between 0 and 1 (for example 0.03).`,
    );
  }
  return parsed;
}

function thresholdsFromEnvironment(): RegressionThresholds {
  const thresholds = {
    warning: envThreshold("EVAL_WARNING_THRESHOLD", 0.03),
    critical: envThreshold("EVAL_CRITICAL_THRESHOLD", 0.08),
    driftFloor: envThreshold("EVAL_DRIFT_MIN", 0.9),
    riskDriftFloor: envThreshold("EVAL_RISK_DRIFT_MIN", 0.98),
  };
  if (thresholds.warning > thresholds.critical) {
    throw new Error(
      "EVAL_WARNING_THRESHOLD cannot exceed EVAL_CRITICAL_THRESHOLD.",
    );
  }
  return thresholds;
}

function concurrencyFromEnvironment(): number {
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error("EVAL_CONCURRENCY must be an integer from 1 to 10.");
  }
  return concurrency;
}

function validateDataset(
  cases: GoldenInput[],
  articles: KnowledgeArticle[],
): void {
  const articleIds = new Set(articles.map((article) => article.id));
  const caseIds = new Set<string>();
  for (const testCase of cases) {
    if (caseIds.has(testCase.id))
      throw new Error(`Duplicate golden case ID: ${testCase.id}`);
    caseIds.add(testCase.id);
    if (
      !CATEGORIES.includes(
        testCase.expected_category as (typeof CATEGORIES)[number],
      )
    ) {
      throw new Error(
        `Unknown category in ${testCase.id}: ${testCase.expected_category}`,
      );
    }
    if (testCase.expected_cited_article_ids.some((id) => !articleIds.has(id))) {
      throw new Error(`Unknown expected citation in ${testCase.id}`);
    }
    if (
      testCase.expected_outcome === "resolved" &&
      hasLowConfidenceMatch(testCase.retrieval_score)
    ) {
      throw new Error(
        `Resolved case ${testCase.id} needs a retrieval score at or above ${CONFIDENCE_THRESHOLD}.`,
      );
    }
    if (
      testCase.expected_is_high_risk &&
      testCase.expected_outcome !== "escalated"
    ) {
      throw new Error(`High-risk case ${testCase.id} must expect escalation.`);
    }
    if (
      testCase.expected_outcome === "escalated" &&
      !testCase.expected_is_high_risk &&
      (testCase.retrieval_score === null ||
        testCase.retrieval_score >= CONFIDENCE_THRESHOLD)
    ) {
      throw new Error(
        `Low-confidence escalation ${testCase.id} must score below ${CONFIDENCE_THRESHOLD}.`,
      );
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeCaseResult(testCase: GoldenInput): RegressionCase {
  return {
    id: testCase.id,
    expected_category: testCase.expected_category,
    expected_is_high_risk: testCase.expected_is_high_risk,
    expected_outcome: testCase.expected_outcome,
    expected_cited_article_ids: testCase.expected_cited_article_ids,
    difficulty: testCase.difficulty,
    metrics: {
      category_match: 0,
      risk_match: 0,
      outcome_match: 0,
      citation_validity:
        testCase.expected_cited_article_ids.length > 0 ? 0 : null,
    },
    actual: {
      category: null,
      is_high_risk: null,
      outcome: null,
      cited_article_ids: [],
      response: null,
    },
    latency_ms: { classify: null, draft: null },
    token_usage: { classify: null, draft: null },
  };
}

async function run(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY;
  const modelName = process.env.GROQ_CHAT_MODEL ?? "openai/gpt-oss-120b";
  if (!apiKey)
    throw new Error(
      "Set GROQ_API_KEY to run the prompt regression evaluation.",
    );

  const datasetFile = await readJson<DatasetFile>(
    path.join(ROOT, "golden-dataset/v1.json"),
  );
  const articles = await readJson<KnowledgeArticle[]>(
    path.join(ROOT, "kb_articles.json"),
  );
  const classifyPrompt = await readJson<PromptFile>(
    path.join(ROOT, "prompts/classify/v1.json"),
  );
  const draftPrompt = await readJson<PromptFile>(
    path.join(ROOT, "prompts/draft/v1.json"),
  );
  validateDataset(datasetFile.cases, articles);

  const articleById = new Map(articles.map((article) => [article.id, article]));
  const model = createChatModel(apiKey, modelName);
  const results = new Map(
    datasetFile.cases.map((testCase) => [
      testCase.id,
      makeCaseResult(testCase),
    ]),
  );
  const jobs = datasetFile.cases.flatMap((testCase) => [
    { kind: "classify" as const, testCase },
    ...(testCase.expected_cited_article_ids.length > 0
      ? [{ kind: "draft" as const, testCase }]
      : []),
  ]);
  let nextJob = 0;
  const worker = async () => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      const result = results.get(job.testCase.id)!;
      const startedAt = performance.now();
      if (job.kind === "classify") {
        try {
          const modelResult = await classifyTicket(model, job.testCase);
          result.actual.category = modelResult.value.category;
          result.actual.is_high_risk = modelResult.value.isHighRisk;
          result.token_usage.classify = modelResult.tokenUsage;
        } catch (error) {
          result.actual.classify_error = errorText(error);
        } finally {
          result.latency_ms.classify = Math.round(
            performance.now() - startedAt,
          );
        }
      } else {
        const retrievedArticles = job.testCase.expected_cited_article_ids.map(
          (id) => {
            const article = articleById.get(id)!;
            return {
              articleId: article.id,
              title: article.title,
              content: article.content,
            };
          },
        );
        try {
          const modelResult = await draftTicketResponse(
            model,
            job.testCase,
            retrievedArticles,
          );
          result.actual.cited_article_ids = modelResult.value.citedArticleIds;
          result.actual.response = modelResult.value.response;
          result.token_usage.draft = modelResult.tokenUsage;
          result.metrics.citation_validity = Number(
            modelResult.value.citedArticleIds.length > 0 &&
              modelResult.value.citedArticleIds.every((id) =>
                retrievedArticles.some((article) => article.articleId === id),
              ),
          );
        } catch (error) {
          result.actual.draft_error = errorText(error);
          result.metrics.citation_validity = 0;
        } finally {
          result.latency_ms.draft = Math.round(performance.now() - startedAt);
        }
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrencyFromEnvironment(), jobs.length) },
      worker,
    ),
  );

  for (const testCase of datasetFile.cases) {
    const result = results.get(testCase.id)!;
    result.metrics.category_match = Number(
      result.actual.category === testCase.expected_category,
    );
    result.metrics.risk_match = Number(
      result.actual.is_high_risk === testCase.expected_is_high_risk,
    );
    if (result.actual.is_high_risk !== null) {
      const outcome =
        result.actual.is_high_risk ||
        hasLowConfidenceMatch(testCase.retrieval_score)
          ? "escalated"
          : "resolved";
      result.actual.outcome = outcome;
    }
    result.metrics.outcome_match = Number(
      result.actual.outcome === testCase.expected_outcome,
    );
  }

  const timestamp = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
    : `${timestamp.replace(/[:.]/g, "-")}-${process.pid}`;
  const historyDirectory = path.join(ROOT, "eval-runs/history");
  await mkdir(historyDirectory, { recursive: true });
  const historyFiles = (await readdir(historyDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const history: EvalSnapshot[] = [];
  for (const file of historyFiles) {
    try {
      history.push(
        await readJson<EvalSnapshot>(path.join(historyDirectory, file)),
      );
    } catch {
      console.warn(`Skipping unreadable evaluation history file: ${file}`);
    }
  }
  history.sort((left, right) =>
    left.generatedAt.localeCompare(right.generatedAt),
  );
  const previous = history.at(-1) ?? null;
  const recentHistory = history.slice(-6);
  const current: EvalSnapshot = {
    runId,
    generatedAt: timestamp,
    model: modelName,
    promptVersions: {
      classify: classifyPrompt.version,
      draft: draftPrompt.version,
    },
    summary: summarizeCases([...results.values()]),
    cases: [...results.values()],
  };
  const comparison = compareRuns(
    current,
    previous,
    recentHistory,
    thresholdsFromEnvironment(),
  );
  const historyPath = path.join(
    historyDirectory,
    `${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`,
  );
  await writeFile(historyPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  const retainedHistory = new Set(
    [...recentHistory, current].map(
      (snapshot) => `${snapshot.runId.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`,
    ),
  );
  await Promise.all(
    historyFiles
      .filter((file) => !retainedHistory.has(file))
      .map((file) => unlink(path.join(historyDirectory, file))),
  );

  const reportDirectory = path.join(ROOT, "eval-runs");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, "regression-report.html");
  await writeFile(
    reportPath,
    buildHtmlReport(current, previous, comparison, [...recentHistory, current]),
    "utf8",
  );
  const reportUrl =
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : reportPath;
  const summary: RunSummary = {
    status: comparison.status,
    current: current.summary,
    comparison,
    runId,
    reportPath,
    reportUrl,
  };
  const summaryPath = path.join(reportDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const githubSummary = process.env.GITHUB_STEP_SUMMARY;
  if (githubSummary) {
    await writeFile(
      githubSummary,
      `## Prompt regression: ${comparison.status.toUpperCase()}\n\n` +
        `Case pass rate: ${(current.summary.casePassRate * 100).toFixed(1)}%\n\n` +
        `Risk accuracy: ${(current.summary.dimensions.risk_match * 100).toFixed(1)}%\n\n` +
        `Regressions: ${comparison.regressions.length}; risk regressions: ${comparison.riskRegressionIds.length}; improvements: ${comparison.improvements.length}\n\n` +
        `Report artifact: ${reportUrl}\n`,
      { encoding: "utf8", flag: "a" },
    );
  }

  console.log(
    `${comparison.status.toUpperCase()}: ${datasetFile.cases.length} cases; ` +
      `pass rate ${(current.summary.casePassRate * 100).toFixed(1)}%; ` +
      `risk accuracy ${(current.summary.dimensions.risk_match * 100).toFixed(1)}%; ` +
      `${comparison.riskRegressionIds.length} risk regressions.`,
  );
  if (comparison.status !== "pass") {
    await postSlackAlert(summary, modelName).catch((error: unknown) => {
      console.warn(`Slack notification failed: ${errorText(error)}`);
    });
  }
  if (comparison.status === "critical") process.exitCode = 1;
}

async function postSlackAlert(
  summary: RunSummary,
  modelName: string,
): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  const categoryDelta = summary.comparison.deltas.category_match;
  const categoryHeadline = categoryDelta
    ? `Category accuracy ${(categoryDelta.previous * 100).toFixed(1)}% to ${(categoryDelta.current * 100).toFixed(1)}%`
    : `Category accuracy ${(summary.current.dimensions.category_match * 100).toFixed(1)}%`;
  const text = [
    `Helpdesk prompt regression ${summary.status.toUpperCase()}`,
    `Case pass rate: ${(summary.current.casePassRate * 100).toFixed(1)}%; ${categoryHeadline}.`,
    `Risk-detection regressions: ${summary.comparison.riskRegressionIds.length} (${summary.comparison.riskRegressionIds.join(", ") || "none"}).`,
    `Model: ${modelName}. Report: ${summary.reportUrl}`,
  ].join("\n");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}.`);
}

run().catch((error: unknown) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
