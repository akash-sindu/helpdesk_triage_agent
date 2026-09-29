import { ChatGroq } from "@langchain/groq";
import { QdrantClient } from "@qdrant/js-client-rest";
import { buildTriageGraph } from "./graph.js";
import { embedQuery } from "./embeddings.js";
import {
  captureGraphExecution,
  evaluateLevel0,
  evaluateLevel1,
  evaluateToolContracts,
  type AgentExecution,
  type EvaluationResult,
  type GoldenCase,
  type SemanticJudge,
  type ToolCall,
} from "./evaluation.js";
import { createSemanticJudge } from "./evaluation-judge.js";
import { createInitialState, type TriageState } from "./state.js";
import { CATEGORIES } from "./state.js";
import { calculateAgentClassificationMetrics } from "./classification-metrics.js";

export interface CaseEvaluation {
  id: string;
  input: { title: string; description: string };
  expected: GoldenCase["expected"];
  execution: AgentExecution;
  nodeCounts: Record<string, number>;
  toolCallCounts: Record<string, number>;
  results: EvaluationResult[];
}

export interface EvaluationReport {
  generatedAt: string;
  levels: number[];
  summary: {
    testCases: number;
    passed: number;
    failed: number;
    byLevel: Record<string, { passed: number; total: number; passRate: number }>;
    classificationMetrics: ReturnType<typeof calculateAgentClassificationMetrics>;
  };
  cases: CaseEvaluation[];
}

function toolNameForStructuredModel(options: unknown): string {
  if (!options || typeof options !== "object") return "structured_model";
  const name = (options as { name?: unknown }).name;
  if (name === "helpdesk_classification") return "classify";
  if (name === "helpdesk_response") return "draft";
  return "structured_model";
}

type FailureInjector = (tool: string) => void;

function instrumentChatModel(model: ChatGroq, calls: ToolCall[], injectFailure: FailureInjector): ChatGroq {
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property !== "withStructuredOutput") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const runnable = Reflect.apply(target.withStructuredOutput, target, args) as {
          invoke: (...invokeArgs: unknown[]) => Promise<unknown>;
        };
        const tool = toolNameForStructuredModel(args[1]);
        return new Proxy(runnable, {
          get(runnableTarget, runnableProperty, runnableReceiver) {
            if (runnableProperty !== "invoke") {
              const value: unknown = Reflect.get(runnableTarget, runnableProperty, runnableReceiver);
              return typeof value === "function" ? value.bind(runnableTarget) : value;
            }
            return async (...invokeArgs: unknown[]) => {
              try {
                injectFailure(tool);
                const output = await runnableTarget.invoke(...invokeArgs);
                calls.push({ tool, input: invokeArgs[0], output });
                return output;
              } catch (error) {
                calls.push({ tool, input: invokeArgs[0], error: errorMessage(error) });
                throw error;
              }
            };
          },
        });
      };
    },
  }) as ChatGroq;
}

function instrumentQdrant(client: QdrantClient, calls: ToolCall[], injectFailure: FailureInjector): QdrantClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "query") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        try {
          injectFailure("qdrant.query");
          const output = await Reflect.apply(target.query, target, args);
          calls.push({ tool: "qdrant.query", input: args, output: output.points });
          return output;
        } catch (error) {
          calls.push({ tool: "qdrant.query", input: args, error: errorMessage(error) });
          throw error;
        }
      };
    },
  }) as QdrantClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function passedResult(result: EvaluationResult): boolean {
  return result.passed;
}

export async function runEvaluation(
  cases: GoldenCase[],
  options: { levels?: number[]; judge?: SemanticJudge; model: ChatGroq; qdrant: QdrantClient; collectionName: string },
): Promise<EvaluationReport> {
  const levels = options.levels ?? [0, 1, 2];
  const results: CaseEvaluation[] = [];

  for (const testCase of cases) {
    const calls: ToolCall[] = [];
    let failuresRemaining = testCase.faultInjection?.failAttempts ?? 0;
    const injectFailure: FailureInjector = (tool) => {
      if (testCase.faultInjection?.tool === tool && failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error(`Evaluation fault injection for ${tool}`);
      }
    };
    const initialState = createInitialState({
      ticketId: `evaluation-${testCase.id}`,
      title: testCase.title,
      description: testCase.description,
    });
    const instrumentedGraph = buildTriageGraph({
      chatModel: instrumentChatModel(options.model, calls, injectFailure),
      embedQuery: async (text) => {
        try {
          injectFailure("embedQuery");
          const output = await embedQuery(text);
          calls.push({ tool: "embedQuery", input: { text }, output });
          return output;
        } catch (error) {
          calls.push({ tool: "embedQuery", input: { text }, error: errorMessage(error) });
          throw error;
        }
      },
      qdrant: instrumentQdrant(options.qdrant, calls, injectFailure),
      collectionName: options.collectionName,
      persist: async (state: TriageState) => {
        calls.push({ tool: "persist", input: { ticketId: state.ticketId, status: state.status }, output: { persisted: true } });
      },
    });
    const execution = await captureGraphExecution(instrumentedGraph, initialState, calls);
    const caseResults: EvaluationResult[] = [];
    if (levels.includes(0)) caseResults.push(await evaluateLevel0(testCase, execution.finalState, options.judge));
    if (levels.includes(1)) caseResults.push(await evaluateLevel1(testCase, execution, options.judge));
    if (levels.includes(2)) caseResults.push(await evaluateToolContracts(testCase, execution, options.judge));
    const nodeCounts = Object.fromEntries(
      [...new Set(execution.trajectory.map((step) => step.node))].map((node) => [
        node,
        execution.trajectory.filter((step) => step.node === node).length,
      ]),
    );
    const toolCallCounts = Object.fromEntries(
      [...new Set(calls.map((call) => call.tool))].map((tool) => [
        tool,
        calls.filter((call) => call.tool === tool).length,
      ]),
    );
    results.push({
      id: testCase.id,
      input: { title: testCase.title, description: testCase.description },
      expected: testCase.expected,
      execution,
      nodeCounts,
      toolCallCounts,
      results: caseResults,
    });
  }

  const byLevel: EvaluationReport["summary"]["byLevel"] = {};
  for (const level of levels) {
    const levelResults = results.flatMap((testCase) => testCase.results).filter((result) => result.level === level);
    const passed = levelResults.filter(passedResult).length;
    byLevel[`level${level}`] = {
      passed,
      total: levelResults.length,
      passRate: levelResults.length ? passed / levelResults.length : 0,
    };
  }
  const allResults = results.flatMap((testCase) => testCase.results);
  const passed = allResults.filter(passedResult).length;
  const classificationMetrics = calculateAgentClassificationMetrics(
    results.map((testCase) => ({
      expected: testCase.expected,
      actual: {
        category: testCase.execution.finalState.category,
        isHighRisk: testCase.execution.finalState.isHighRisk,
        escalated: testCase.execution.finalState.status === "escalated",
      },
    })),
    [...CATEGORIES],
  );
  return {
    generatedAt: new Date().toISOString(),
    levels,
    summary: {
      testCases: cases.length,
      passed,
      failed: allResults.length - passed,
      byLevel,
      classificationMetrics,
    },
    cases: results,
  };
}

export function createJudgeIfEnabled(model: ChatGroq, enabled: boolean): SemanticJudge | undefined {
  return enabled ? createSemanticJudge(model) : undefined;
}