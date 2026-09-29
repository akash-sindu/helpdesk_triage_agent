import { Annotation } from "@langchain/langgraph";

export const CATEGORIES = [
  "Network & connectivity",
  "Account & access",
  "Software & licensing",
  "Hardware",
  "Collaboration tools",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type NodeFailureReason = "api_error" | "invalid_output";
export type TriageStatus = "pending" | "resolved" | "escalated" | "error";
export type TriageNode = "classify" | "retrieve" | "draft";

export interface AuditEntry {
  timestamp: string;
  node: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface RetrievedArticle {
  articleId: string;
  title: string;
  score: number;
}

export interface RetrievedArticleContent {
  articleId: string;
  title: string;
  content: string;
}

export interface TriageState {
  ticketId: string;
  title: string;
  description: string;
  category: Category | null;
  isHighRisk: boolean | null;
  classificationReasoning: string | null;
  retrievedArticles: RetrievedArticle[];
  retrievedArticleContent: RetrievedArticleContent[];
  topMatchScore: number | null;
  draftResponse: string | null;
  citedArticleIds: string[];
  status: TriageStatus;
  finalMessageToUser: string | null;
  retryCount: Record<TriageNode, number>;
  lastFailureReason: NodeFailureReason | null;
  auditLog: AuditEntry[];
  createdAt: string;
  updatedAt: string;
}

export const TriageStateAnnotation = Annotation.Root({
  ticketId: Annotation<string>(),
  title: Annotation<string>(),
  description: Annotation<string>(),
  category: Annotation<Category | null>(),
  isHighRisk: Annotation<boolean | null>(),
  classificationReasoning: Annotation<string | null>(),
  retrievedArticles: Annotation<RetrievedArticle[]>(),
  retrievedArticleContent: Annotation<RetrievedArticleContent[]>(),
  topMatchScore: Annotation<number | null>(),
  draftResponse: Annotation<string | null>(),
  citedArticleIds: Annotation<string[]>(),
  status: Annotation<TriageStatus>(),
  finalMessageToUser: Annotation<string | null>(),
  retryCount: Annotation<Record<TriageNode, number>>(),
  lastFailureReason: Annotation<NodeFailureReason | null>(),
  auditLog: Annotation<AuditEntry[]>(),
  createdAt: Annotation<string>(),
  updatedAt: Annotation<string>(),
});

export function createAuditEntry(
  node: string,
  action: string,
  detail: Record<string, unknown>,
): AuditEntry {
  return { timestamp: new Date().toISOString(), node, action, detail };
}

export function createInitialState(input: {
  ticketId: string;
  title: string;
  description: string;
}): TriageState {
  const createdAt = new Date().toISOString();
  return {
    ...input,
    category: null,
    isHighRisk: null,
    classificationReasoning: null,
    retrievedArticles: [],
    retrievedArticleContent: [],
    topMatchScore: null,
    draftResponse: null,
    citedArticleIds: [],
    status: "pending",
    finalMessageToUser: null,
    retryCount: { classify: 0, retrieve: 0, draft: 0 },
    lastFailureReason: null,
    auditLog: [
      createAuditEntry("intake", "ticket_received", {
        title: input.title,
      }),
    ],
    createdAt,
    updatedAt: createdAt,
  };
}