type ProfileContext = {
    profileId: string;
    apiKey: string;
    provider: string;
    model: string;
};
type ProfileDefinition = {
    id?: string;
    provider: string;
    model?: string;
    apiKey: string;
};
type FallbackModelDefinition = {
    provider: string;
    model: string;
    apiKey?: string;
};
type RunOptions = {
    model?: string;
    provider?: string;
    signal?: AbortSignal;
    label?: string;
    maxWaitMs?: number;
};
type LlmKeyPoolResult<T> = {
    value: T;
    profileId: string;
    provider: string;
    model: string;
    attempts: FailedAttempt[];
};
type FailedAttempt = {
    profileId: string;
    provider: string;
    model: string;
    error: string;
    reason: FailureReason;
};
type FailureReason = "rate_limit" | "server_error" | "auth" | "auth_permanent" | "billing" | "timeout" | "model_not_found" | "format" | "unknown";
type CooldownConfig = {
    maxRateLimitCooldownMs?: number;
    billingBackoffMs?: number;
    billingMaxMs?: number;
    failureWindowMs?: number;
};
type Logger = {
    debug?: (msg: string, ...args: unknown[]) => void;
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
};
type LlmKeyPoolConfig = {
    profiles: ProfileDefinition[];
    fallbackModels?: FallbackModelDefinition[];
    storagePath?: string;
    cooldowns?: CooldownConfig;
    maxWaitMs?: number;
    logger?: Logger;
};
type PoolStatus = {
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

declare class LlmKeyPool {
    private readonly profiles;
    private readonly profileOrder;
    private readonly fallbackOrder;
    private readonly storagePath?;
    private readonly cooldownConfig;
    private readonly maxWaitMs?;
    private readonly logger?;
    constructor(config: LlmKeyPoolConfig);
    /**
     * Initialize from persisted state. Call after construction if using storagePath.
     */
    init(): Promise<void>;
    run<T>(task: (ctx: ProfileContext) => Promise<T>, opts?: RunOptions): Promise<LlmKeyPoolResult<T>>;
    markFailure(profileId: string, reason: FailureReason): Promise<void>;
    markSuccess(profileId: string): Promise<void>;
    isInCooldown(profileId: string): boolean;
    clearCooldown(profileId: string): Promise<void>;
    getStatus(): PoolStatus;
    private buildCandidates;
    private pickCandidate;
    private soonestCooldownWait;
    private persist;
    private sleep;
}

/**
 * Classify an error into a FailureReason for cooldown/disable decisions.
 */
declare function classifyError(error: unknown): FailureReason;

/**
 * Throw this from your task function to explicitly signal a retryable error.
 * The pool will classify it and move to the next profile.
 */
declare class FailoverError extends Error {
    readonly failureReason: FailureReason;
    readonly isTimeout: boolean;
    constructor(message: string, opts?: {
        reason?: FailureReason;
        isTimeout?: boolean;
        cause?: unknown;
    });
}
/**
 * Thrown when all profiles and fallback candidates are exhausted.
 */
declare class AllProfilesExhaustedError extends Error {
    readonly attempts: FailedAttempt[];
    constructor(attempts: FailedAttempt[]);
}

export { AllProfilesExhaustedError, type CooldownConfig, type FailedAttempt, FailoverError, type FailureReason, type FallbackModelDefinition, LlmKeyPool, type LlmKeyPoolConfig, type LlmKeyPoolResult, type Logger, type PoolStatus, type ProfileContext, type ProfileDefinition, type RunOptions, classifyError };
