export type ProfileContext = {
  profileId: string;
  apiKey: string;
  provider: string;
  model: string;
};

export type ProfileDefinition = {
  id?: string;
  provider: string;
  model?: string;
  apiKey: string;
  weight?: number;
};

export type FallbackModelDefinition = {
  provider: string;
  model: string;
  apiKey?: string;
};

export type RunOptions = {
  model?: string;
  provider?: string;
  signal?: AbortSignal;
  label?: string;
};

export type LlmKeyPoolResult<T> = {
  value: T;
  profileId: string;
  provider: string;
  model: string;
  attempts: FailedAttempt[];
};

export type FailedAttempt = {
  profileId: string;
  provider: string;
  model: string;
  error: string;
  reason: FailureReason;
};

export type FailureReason =
  | "rate_limit"
  | "auth"
  | "auth_permanent"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "format"
  | "unknown";

export type CooldownConfig = {
  maxRateLimitCooldownMs?: number;
  billingBackoffMs?: number;
  billingMaxMs?: number;
  failureWindowMs?: number;
};

export type Logger = {
  debug?: (msg: string, ...args: unknown[]) => void;
  info?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
  error?: (msg: string, ...args: unknown[]) => void;
};

export type LlmKeyPoolConfig = {
  profiles: ProfileDefinition[];
  fallbackModels?: FallbackModelDefinition[];
  storagePath?: string;
  cooldowns?: CooldownConfig;
  logger?: Logger;
};

export type PoolStatus = {
  profiles: Array<{
    id: string;
    provider: string;
    model?: string;
    state: "available" | "cooldown" | "disabled";
    cooldownUntil?: number;
    errorCount: number;
    lastUsed?: number;
    lastFailure?: number;
  }>;
  totalAvailable: number;
  totalInCooldown: number;
  unavailableReason: FailureReason | null;
};

/** Internal mutable state for a single profile */
export type ProfileState = {
  id: string;
  provider: string;
  model?: string;
  apiKey: string;
  weight: number;
  errorCount: number;
  lastUsed?: number;
  lastFailure?: number;
  lastSuccess?: number;
  cooldownUntil?: number;
  lastFailureReason?: FailureReason;
};

/** Shape persisted to disk */
export type PersistedState = {
  version: 1;
  profiles: Record<
    string,
    {
      errorCount: number;
      lastUsed?: number;
      lastFailure?: number;
      lastSuccess?: number;
      cooldownUntil?: number;
      lastFailureReason?: FailureReason;
    }
  >;
};
