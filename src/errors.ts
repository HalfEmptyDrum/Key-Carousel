import type { FailedAttempt, FailureReason } from "./types.js";

/**
 * Throw this from your task function to explicitly signal a retryable error.
 * The pool will classify it and move to the next profile.
 */
export class FailoverError extends Error {
  readonly failureReason: FailureReason;
  readonly isTimeout: boolean;

  constructor(
    message: string,
    opts?: { reason?: FailureReason; isTimeout?: boolean; cause?: unknown },
  ) {
    super(message, { cause: opts?.cause });
    this.name = "FailoverError";
    this.failureReason = opts?.reason ?? "unknown";
    this.isTimeout = opts?.isTimeout ?? false;
  }
}

/**
 * Thrown when all profiles and fallback candidates are exhausted.
 */
export class AllProfilesExhaustedError extends Error {
  readonly attempts: FailedAttempt[];

  constructor(attempts: FailedAttempt[]) {
    const summary = attempts
      .map((a) => `  ${a.profileId} (${a.provider}/${a.model}): ${a.reason} — ${a.error}`)
      .join("\n");
    super(`All LLM profiles exhausted after ${attempts.length} attempt(s):\n${summary}`);
    this.name = "AllProfilesExhaustedError";
    this.attempts = attempts;
  }
}
