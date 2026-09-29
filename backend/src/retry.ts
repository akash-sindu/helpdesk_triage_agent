import {
  createAuditEntry,
  type NodeFailureReason,
  type TriageNode,
  type TriageState,
} from "./state.js";
import { logError } from "./logging.js";

export const MAX_ATTEMPTS = 4;
export const ERROR_MESSAGE =
  "Sorry, something went wrong while processing your request. Please try again later or contact IT directly.";

export class NodeFailure extends Error {
  constructor(
    readonly reason: NodeFailureReason,
    message: string,
    readonly diagnostics: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "NodeFailure";
  }
}

export async function runWithRetry<T>(
  state: TriageState,
  node: TriageNode,
  operation: (attemptNumber: number) => Promise<T>,
): Promise<
  { ok: true; value: T; state: TriageState } | { ok: false; state: TriageState }
> {
  const retryCount = { ...state.retryCount };
  const auditLog = [...state.auditLog];
  let lastFailureReason: NodeFailureReason = "api_error";

  for (
    let attemptNumber = 1;
    attemptNumber <= MAX_ATTEMPTS;
    attemptNumber += 1
  ) {
    try {
      const value = await operation(attemptNumber);
      return {
        ok: true,
        value,
        state: { ...state, retryCount, auditLog, lastFailureReason: null },
      };
    } catch (error) {
      lastFailureReason =
        error instanceof NodeFailure ? error.reason : "api_error";
      retryCount[node] += 1;
      logError("triage.node.attempt_failed", error, {
        node,
        attemptNumber,
        failureReason: lastFailureReason,
        ...(error instanceof NodeFailure ? error.diagnostics : {}),
      });

      if (attemptNumber < MAX_ATTEMPTS) {
        auditLog.push(
          createAuditEntry(node, "retry", {
            node,
            attemptNumber: attemptNumber + 1,
            lastFailureReason,
          }),
        );
        continue;
      }

      auditLog.push(
        createAuditEntry(node, "node_failed_max_retries", {
          node,
          lastFailureReason,
        }),
      );
      return {
        ok: false,
        state: {
          ...state,
          retryCount,
          lastFailureReason,
          status: "error",
          finalMessageToUser: ERROR_MESSAGE,
          auditLog,
          updatedAt: new Date().toISOString(),
        },
      };
    }
  }

  throw new Error("Retry loop exited unexpectedly");
}
