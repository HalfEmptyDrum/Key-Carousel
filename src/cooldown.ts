import type { CooldownConfig, FailureReason } from "./types.js";

const DEFAULTS: Required<CooldownConfig> = {
  maxRateLimitCooldownMs: 3_600_000, // 1hr
  billingBackoffMs: 18_000_000, // 5hr
  billingMaxMs: 86_400_000, // 24hr
  failureWindowMs: 86_400_000, // 24hr
};

export function resolvedConfig(config?: CooldownConfig): Required<CooldownConfig> {
  return { ...DEFAULTS, ...config };
}

/**
 * Compute cooldown duration for rate_limit / timeout / unknown errors.
 * Formula: min(maxMs, 60_000 * 5^min(errorCount-1, 3))
 */
export function rateLimitCooldownMs(errorCount: number, maxMs: number): number {
  const exp = Math.min(errorCount - 1, 3);
  return Math.min(maxMs, 60_000 * Math.pow(5, exp));
}

/**
 * Compute disable duration for billing / auth_permanent errors.
 * Formula: min(billingMaxMs, billingBackoffMs * 2^min(errorCount-1, 10))
 */
export function billingDisableMs(
  errorCount: number,
  billingBackoffMs: number,
  billingMaxMs: number,
): number {
  const exp = Math.min(errorCount - 1, 10);
  return Math.min(billingMaxMs, billingBackoffMs * Math.pow(2, exp));
}

/**
 * Is this reason a "billing/permanent" class of error?
 */
export function isBillingReason(reason: FailureReason): boolean {
  return reason === "billing" || reason === "auth_permanent";
}

/**
 * Compute the cooldown duration based on error count and reason.
 */
export function computeCooldownMs(
  errorCount: number,
  reason: FailureReason,
  config: Required<CooldownConfig>,
): number {
  if (isBillingReason(reason)) {
    return billingDisableMs(errorCount, config.billingBackoffMs, config.billingMaxMs);
  }
  return rateLimitCooldownMs(errorCount, config.maxRateLimitCooldownMs);
}
