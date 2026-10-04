import { END, START, StateGraph } from "@langchain/langgraph";
import classifyPrompt from "../../prompts/classify/v1.json" with { type: "json" };
import draftPrompt from "../../prompts/draft/v1.json" with { type: "json" };
import { OutputParserException } from "@langchain/core/output_parsers";
import { ChatGroq } from "@langchain/groq";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { embedQuery as EmbedQuery } from "./embeddings.js";
import { logInfo } from "./logging.js";
import { z } from "zod";
import { detectKeywordRisk, getRiskSignalLabel } from "./risk.js";
import { NodeFailure, runWithRetry } from "./retry.js";
import {
  normalizeClassificationOutput,
  normalizeDraftOutput,
  unwrapStructuredOutput,
} from "./structured-output.js";
import {
  CATEGORIES,
  createAuditEntry,
  TriageStateAnnotation,
  type Category,
  type TriageState,
} from "./state.js";

const CONFIDENCE_THRESHOLD = 0.6;

export function hasLowConfidenceMatch(topMatchScore: number | null): boolean {
  return topMatchScore === null || topMatchScore < CONFIDENCE_THRESHOLD;
}

const classificationSchema = z.object({
  category: z.enum(CATEGORIES),
  isHighRisk: z.boolean(),
  reasoning: z.string().min(1),
});

const draftSchema = z.object({
  response: z.string().min(1),
  citedArticleIds: z.array(z.string()),
});

export interface NodeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface NodeModelResult<T> {
  value: T;
  tokenUsage: NodeTokenUsage | null;
}

export interface ClassificationResult {
  category: z.infer<typeof classificationSchema>["category"];
  isHighRisk: boolean;
  llmRisk: boolean;
  keywordRisk: boolean;
  reasoning: string;
}

function tokenUsageFromOutput(output: unknown): NodeTokenUsage | null {
  if (typeof output !== "object" || output === null || !("raw" in output)) {
    return null;
  }
  const raw = output.raw;
  if (typeof raw !== "object" || raw === null || !("usage_metadata" in raw)) {
    return null;
  }
  const usage = raw.usage_metadata;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = record.input_tokens;
  const outputTokens = record.output_tokens;
  const totalTokens = record.total_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}

export async function classifyTicket(
  chatModel: ChatGroq,
  ticket: Pick<TriageState, "title" | "description">,
): Promise<NodeModelResult<ClassificationResult>> {
  const classifier = chatModel.withStructuredOutput(classificationSchema, {
    name: "helpdesk_classification",
    method: "jsonMode",
    includeRaw: true,
  });
  let output: unknown;
  try {
    output = await classifier.invoke(
      [
        [
          "system",
          classifyPrompt.systemPrompt.replace(
            "{{categories}}",
            CATEGORIES.join(", "),
          ),
        ],
        ["human", `Title: ${ticket.title}\nDescription: ${ticket.description}`],
      ],
      { timeout: 12000 },
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof OutputParserException) {
      throw new NodeFailure(
        "invalid_output",
        "Groq classification response could not be parsed as the expected JSON schema",
        { parser: "groq_structured_output", sourceErrorName: error.name },
      );
    }
    throw error;
  }
  const parsed = classificationSchema.safeParse(
    normalizeClassificationOutput(unwrapStructuredOutput(output)),
  );
  if (!parsed.success) {
    throw new NodeFailure(
      "invalid_output",
      "Groq classification response did not match the expected schema",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  const keywordRisk = detectKeywordRisk(ticket.title, ticket.description);
  return {
    value: {
      ...parsed.data,
      isHighRisk: keywordRisk || parsed.data.isHighRisk,
      llmRisk: parsed.data.isHighRisk,
      keywordRisk,
    },
    tokenUsage: tokenUsageFromOutput(output),
  };
}

export async function draftTicketResponse(
  chatModel: ChatGroq,
  ticket: Pick<TriageState, "title" | "description">,
  articles: TriageState["retrievedArticleContent"],
): Promise<NodeModelResult<z.infer<typeof draftSchema>>> {
  const retrievedIds = new Set(articles.map((article) => article.articleId));
  const context = articles
    .map(
      (article) =>
        `Article ID: ${article.articleId}\nTitle: ${article.title}\nContent: ${article.content}`,
    )
    .join("\n\n");
  if (context.length === 0) {
    throw new NodeFailure(
      "api_error",
      "No retrieved article content is available",
    );
  }
  const draftModel = chatModel.withStructuredOutput(draftSchema, {
    name: "helpdesk_response",
    method: "jsonMode",
    includeRaw: true,
  });
  let output: unknown;
  try {
    output = await draftModel.invoke(
      [
        ["system", draftPrompt.systemPrompt],
        [
          "human",
          `Ticket title: ${ticket.title}\nTicket description: ${ticket.description}\n\nRetrieved knowledge-base articles:\n${context}`,
        ],
      ],
      { timeout: 12000 },
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof OutputParserException) {
      throw new NodeFailure(
        "invalid_output",
        "Groq draft response could not be parsed as the expected JSON schema",
        { parser: "groq_structured_output", sourceErrorName: error.name },
      );
    }
    throw error;
  }
  const parsed = draftSchema.safeParse(
    normalizeDraftOutput(unwrapStructuredOutput(output)),
  );
  if (!parsed.success) {
    throw new NodeFailure(
      "invalid_output",
      "Groq draft response did not match the expected schema",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  if (
    parsed.data.citedArticleIds.length === 0 ||
    parsed.data.citedArticleIds.some((id) => !retrievedIds.has(id))
  ) {
    throw new NodeFailure(
      "invalid_output",
      "Draft citations must reference retrieved article IDs",
    );
  }
  return { value: parsed.data, tokenUsage: tokenUsageFromOutput(output) };
}

export interface TriageDependencies {
  chatModel: ChatGroq;
  embedQuery: typeof EmbedQuery;
  qdrant: QdrantClient;
  collectionName: string;
  persist: (state: TriageState) => Promise<void>;
}

function errorPatch(state: TriageState) {
  return {
    status: state.status,
    finalMessageToUser: state.finalMessageToUser,
    retryCount: state.retryCount,
    lastFailureReason: state.lastFailureReason,
    auditLog: state.auditLog,
    updatedAt: state.updatedAt,
  };
}

export function buildTriageGraph(dependencies: TriageDependencies) {
  const classifyNode = async (state: TriageState) => {
    logInfo("triage.node.started", {
      node: "classify",
      ticketId: state.ticketId,
    });
    const result = await runWithRetry(state, "classify", async () =>
      (await classifyTicket(dependencies.chatModel, state)).value,
    );
    if (!result.ok) return errorPatch(result.state);
    const { category, isHighRisk, llmRisk, keywordRisk, reasoning } =
      result.value;
    logInfo("triage.node.completed", {
      ticketId: state.ticketId,
      category,
      isHighRisk,
      keywordRisk,
      llmRisk,
    });
    const timestamp = new Date().toISOString();
    return {
      category: category as Category,
      isHighRisk,
      classificationReasoning: reasoning,
      retryCount: result.state.retryCount,
      lastFailureReason: null,
      status: "pending" as const,
      auditLog: [
        ...result.state.auditLog,
        createAuditEntry("classify", "classified", {
          category,
          isHighRisk,
          reasoning,
          riskSignals: {
            keyword: keywordRisk,
            llm: llmRisk,
            triggeredBy: getRiskSignalLabel(keywordRisk, llmRisk),
          },
        }),
      ],
      updatedAt: timestamp,
    };
  };

  const escalateNode = async (state: TriageState) => {
    logInfo("triage.node.started", {
      node: "escalate",
      ticketId: state.ticketId,
    });
    const timestamp = new Date().toISOString();
    const message =
      "Thanks. This has been passed to the IT team and someone will reach out to you shortly.";
    return {
      status: "escalated" as const,
      finalMessageToUser: message,
      auditLog: [
        ...state.auditLog,
        createAuditEntry("escalate", "escalated_to_human", {
          reasoning: state.classificationReasoning,
          isHighRisk: state.isHighRisk,
        }),
        createAuditEntry("escalate", "closed_demo_mock", {
          note: "Simulated closure; no human ticket queue is connected.",
        }),
      ],
      updatedAt: timestamp,
    };
  };

  const retrieveNode = async (state: TriageState) => {
    logInfo("triage.node.started", {
      node: "retrieve",
      ticketId: state.ticketId,
      category: state.category,
      collectionName: dependencies.collectionName,
    });
    const result = await runWithRetry(state, "retrieve", async () => {
      const vector = await dependencies.embedQuery(
        `${state.title}\n${state.description}`,
      );
      const response = await dependencies.qdrant.query(
        dependencies.collectionName,
        {
          query: vector,
          limit: 3,
          with_payload: true,
        },
      );
      return response.points.map((point) => {
        const payload = point.payload ?? {};
        if (
          typeof payload.articleId !== "string" ||
          typeof payload.title !== "string" ||
          typeof payload.content !== "string"
        ) {
          throw new NodeFailure(
            "invalid_output",
            "Qdrant result is missing article fields",
          );
        }
        return {
          articleId: payload.articleId,
          title: payload.title,
          content: payload.content,
          score: point.score,
        };
      });
    });

    if (!result.ok) return errorPatch(result.state);
    const articles = result.value;
    const topMatchScore = articles[0]?.score ?? null;
    const timestamp = new Date().toISOString();
    logInfo("triage.retrieval.completed", {
      ticketId: state.ticketId,
      resultCount: articles.length,
      topMatchScore,
      threshold: CONFIDENCE_THRESHOLD,
      articleIds: articles.map((article) => article.articleId),
    });

    if (hasLowConfidenceMatch(topMatchScore)) {
      return {
        retrievedArticles: articles.map(({ articleId, title, score }) => ({
          articleId,
          title,
          score,
        })),
        retrievedArticleContent: articles.map(
          ({ articleId, title, content }) => ({
            articleId,
            title,
            content,
          }),
        ),
        topMatchScore,
        status: "escalated" as const,
        finalMessageToUser:
          "We couldn't find a confident match for this issue, so it's been passed to the IT team.",
        retryCount: result.state.retryCount,
        lastFailureReason: null,
        auditLog: [
          ...result.state.auditLog,
          createAuditEntry("retrieve", "escalated_low_confidence", {
            topMatchScore,
            threshold: CONFIDENCE_THRESHOLD,
          }),
          createAuditEntry("escalate", "closed_demo_mock", {
            note: "Simulated closure; no human ticket queue is connected.",
          }),
        ],
        updatedAt: timestamp,
      };
    }

    return {
      retrievedArticles: articles.map(({ articleId, title, score }) => ({
        articleId,
        title,
        score,
      })),
      retrievedArticleContent: articles.map(
        ({ articleId, title, content }) => ({
          articleId,
          title,
          content,
        }),
      ),
      topMatchScore,
      retryCount: result.state.retryCount,
      lastFailureReason: null,
      auditLog: [
        ...result.state.auditLog,
        createAuditEntry("retrieve", "articles_retrieved", {
          articles: articles.map(({ articleId, score }) => ({
            articleId,
            score,
          })),
          topMatchScore,
        }),
      ],
      updatedAt: timestamp,
    };
  };

  const draftNode = async (state: TriageState) => {
    const result = await runWithRetry(state, "draft", async () =>
      (
        await draftTicketResponse(
          dependencies.chatModel,
          state,
          state.retrievedArticleContent,
        )
      ).value,
    );

    if (!result.ok) return errorPatch(result.state);
    logInfo("triage.node.completed", {
      node: "draft",
      ticketId: state.ticketId,
      citedArticleIds: result.value.citedArticleIds,
    });
    const timestamp = new Date().toISOString();
    return {
      draftResponse: result.value.response,
      citedArticleIds: result.value.citedArticleIds,
      finalMessageToUser: result.value.response,
      status: "resolved" as const,
      retryCount: result.state.retryCount,
      lastFailureReason: null,
      auditLog: [
        ...result.state.auditLog,
        createAuditEntry("draft", "response_drafted", {
          draft: result.value.response,
          citedArticleIds: result.value.citedArticleIds,
        }),
      ],
      updatedAt: timestamp,
    };
  };

  const persistNode = async (state: TriageState) => {
    logInfo("triage.persistence.started", {
      ticketId: state.ticketId,
      status: state.status,
      auditEntryCount: state.auditLog.length,
    });
    const finalState = {
      ...state,
      updatedAt: new Date().toISOString(),
      auditLog: [
        ...state.auditLog,
        createAuditEntry("send_response", "ticket_persisted", {
          status: state.status,
        }),
      ],
    };
    await dependencies.persist(finalState);
    logInfo("triage.persistence.completed", {
      ticketId: state.ticketId,
      status: state.status,
    });
    return { updatedAt: finalState.updatedAt };
  };

  return new StateGraph(TriageStateAnnotation)
    .addNode("classify", classifyNode)
    .addNode("escalate", escalateNode)
    .addNode("retrieve", retrieveNode)
    .addNode("draft", draftNode)
    .addNode("persist", persistNode)
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (state) => {
      if (state.status === "error") return "persist";
      return state.isHighRisk ? "escalate" : "retrieve";
    })
    .addEdge("escalate", "persist")
    .addConditionalEdges("retrieve", (state) =>
      state.status === "pending" ? "draft" : "persist",
    )
    .addConditionalEdges("draft", () => "persist")
    .addEdge("persist", END)
    .compile();
}
