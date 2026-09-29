type LogFields = Record<string, unknown>;

function redactMessage(message: string) {
  return message
    .replace(/\bgsk_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

export function logInfo(event: string, fields: LogFields = {}) {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "INFO",
      service: "helpdesk-triage",
      event,
      ...fields,
    }),
  );
}

export function logWarn(event: string, fields: LogFields = {}) {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "WARN",
      service: "helpdesk-triage",
      event,
      ...fields,
    }),
  );
}

export function logError(
  event: string,
  error: unknown,
  fields: LogFields = {},
) {
  const errorDetails =
    error instanceof Error
      ? {
          errorName: error.name,
          message: redactMessage(error.message),
          ...(typeof (error as Error & { status?: unknown }).status === "number"
            ? { status: (error as Error & { status: number }).status }
            : {}),
          ...(typeof (error as Error & { statusCode?: unknown }).statusCode ===
          "number"
            ? { statusCode: (error as Error & { statusCode: number }).statusCode }
            : {}),
          ...(typeof (error as Error & { code?: unknown }).code === "string"
            ? { code: (error as Error & { code: string }).code }
            : {}),
          ...getProviderResponseDetail(error),
        }
      : { errorName: "UnknownError" };

  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "ERROR",
      service: "helpdesk-triage",
      event,
      ...fields,
      ...errorDetails,
    }),
  );
}

function getProviderResponseDetail(error: Error) {
  const data = (error as Error & { data?: unknown }).data;
  if (!data || typeof data !== "object") return {};
  const status = (data as { status?: unknown }).status;
  if (!status || typeof status !== "object") return {};
  const detail = (status as { error?: unknown }).error;
  if (typeof detail !== "string") return {};
  return { providerDetail: redactMessage(detail) };
}