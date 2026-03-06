import type { FailureReason } from "./types.js";
import { FailoverError } from "./errors.js";

/**
 * Classify an error into a FailureReason for cooldown/disable decisions.
 */
export function classifyError(error: unknown): FailureReason {
  if (error instanceof FailoverError) {
    return error.failureReason;
  }

  const status = extractStatus(error);
  if (status !== undefined) {
    if (status === 401) return "auth";
    if (status === 403) return "auth_permanent";
    if (status === 402) return "billing";
    if (status === 429) return "rate_limit";
    if (status === 404) return "model_not_found";
    if (status === 400) return "format";
  }

  const message = extractMessage(error).toLowerCase();

  if (/rate.?limit|too many requests|throttl/i.test(message)) return "rate_limit";
  if (/billing|payment|quota.*(exceeded|limit)|insufficient.*(fund|credit)/i.test(message))
    return "billing";
  if (/unauthorized|invalid.*api.?key|authentication/i.test(message)) return "auth";
  if (/forbidden|permission|access.denied/i.test(message)) return "auth_permanent";
  if (/model.*not.*found|does not exist|unknown model/i.test(message)) return "model_not_found";
  if (/context.length|token.*limit|max.*token/i.test(message)) return "format";
  if (/timeout|timed?.out|ETIMEDOUT|ECONNABORTED/i.test(message)) return "timeout";

  if (isAbortError(error)) return "timeout";

  return "unknown";
}

function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e["status"] === "number") return e["status"];
    if (typeof e["statusCode"] === "number") return e["statusCode"];
    if (e["response"] && typeof e["response"] === "object") {
      const r = e["response"] as Record<string, unknown>;
      if (typeof r["status"] === "number") return r["status"];
    }
  }
  return undefined;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return false;
}

export function isNonTimeoutAbort(error: unknown): boolean {
  if (error instanceof FailoverError) {
    return false; // FailoverErrors are always retryable
  }
  if (!isAbortError(error)) return false;
  // If it's an AbortError, check if it's from a timeout
  // A non-timeout abort should be rethrown immediately
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (/timeout|timed?.out/i.test(msg)) return false; // timeout abort → retryable
  }
  return true; // genuine user/signal abort → rethrow
}
