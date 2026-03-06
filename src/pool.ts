import { classifyError, isNonTimeoutAbort } from "./classify.js";
import { computeCooldownMs, isBillingReason, resolvedConfig } from "./cooldown.js";
import { AllProfilesExhaustedError } from "./errors.js";
import { applyPersistedState, loadState, saveState } from "./persistence.js";
import type {
  CooldownConfig,
  FailedAttempt,
  FailureReason,
  LlmKeyPoolConfig,
  LlmKeyPoolResult,
  Logger,
  PoolStatus,
  ProfileContext,
  ProfileState,
  RunOptions,
} from "./types.js";

export class LlmKeyPool {
  private readonly profiles: Map<string, ProfileState> = new Map();
  private readonly profileOrder: string[] = [];
  private readonly fallbackOrder: string[] = [];
  private readonly storagePath?: string;
  private readonly cooldownConfig: Required<CooldownConfig>;
  private readonly maxWaitMs?: number;
  private readonly logger?: Logger;

  constructor(config: LlmKeyPoolConfig) {
    this.storagePath = config.storagePath;
    this.cooldownConfig = resolvedConfig(config.cooldowns);
    this.maxWaitMs = config.maxWaitMs;
    this.logger = config.logger;

    // Validate cooldown config
    if (config.cooldowns) {
      const cd = config.cooldowns;
      if (cd.maxRateLimitCooldownMs !== undefined && cd.maxRateLimitCooldownMs < 0) {
        throw new Error("maxRateLimitCooldownMs must be non-negative");
      }
      if (cd.billingBackoffMs !== undefined && cd.billingBackoffMs < 0) {
        throw new Error("billingBackoffMs must be non-negative");
      }
      if (cd.billingMaxMs !== undefined && cd.billingMaxMs < 0) {
        throw new Error("billingMaxMs must be non-negative");
      }
      if (cd.failureWindowMs !== undefined && cd.failureWindowMs < 0) {
        throw new Error("failureWindowMs must be non-negative");
      }
    }

    // Register primary profiles
    let idx = 0;
    for (const def of config.profiles) {
      const id = def.id ?? `profile-${idx}`;
      if (this.profiles.has(id)) {
        throw new Error(`Duplicate profile ID: "${id}"`);
      }
      if (!def.apiKey) {
        throw new Error(`Profile "${id}" has an empty API key`);
      }
      if (!def.provider) {
        throw new Error(`Profile "${id}" has an empty provider`);
      }
      this.profiles.set(id, {
        id,
        provider: def.provider,
        model: def.model,
        apiKey: def.apiKey,
        errorCount: 0,
      });
      this.profileOrder.push(id);
      idx++;
    }

    // Register fallback models as independent profiles
    const fallbackModels = config.fallbackModels ?? [];
    for (const fb of fallbackModels) {
      const fallbackId = `fallback-${fb.provider}-${fb.model}`;
      const matchingProfile = this.profileOrder.find(
        (id) => this.profiles.get(id)!.provider === fb.provider,
      );
      const apiKey = fb.apiKey ?? (matchingProfile ? this.profiles.get(matchingProfile)!.apiKey : undefined);
      if (apiKey) {
        if (this.profiles.has(fallbackId)) {
          throw new Error(`Duplicate fallback ID: "${fallbackId}"`);
        }
        this.profiles.set(fallbackId, {
          id: fallbackId,
          provider: fb.provider,
          model: fb.model,
          apiKey,
          errorCount: 0,
        });
        this.fallbackOrder.push(fallbackId);
      }
    }

    // Validate that there's at least one usable profile
    if (this.profiles.size === 0) {
      throw new Error("At least one profile or fallback with an API key is required");
    }
  }

  /**
   * Initialize from persisted state. Call after construction if using storagePath.
   */
  async init(): Promise<void> {
    if (!this.storagePath) return;
    const persisted = await loadState(this.storagePath, this.logger);
    if (persisted) {
      applyPersistedState(this.profiles, persisted);
      this.logger?.info?.("Loaded persisted state for " + this.profiles.size + " profiles");
    }
  }

  async run<T>(
    task: (ctx: ProfileContext) => Promise<T>,
    opts?: RunOptions,
  ): Promise<LlmKeyPoolResult<T>> {
    const attempts: FailedAttempt[] = [];
    const profileCount = this.profiles.size;
    const maxIterations = Math.min(160, Math.max(32, 24 + profileCount * 8));

    // Build candidate list: primary profiles + fallback models
    const candidates = this.buildCandidates(opts);

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Check abort signal
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }

      const candidate = this.pickCandidate(candidates);

      if (!candidate) {
        // All profiles in cooldown — wait for soonest expiry
        const waitMs = this.soonestCooldownWait();
        if (waitMs === null) {
          // All permanently disabled
          throw new AllProfilesExhaustedError(attempts);
        }

        const maxWait = opts?.maxWaitMs ?? this.maxWaitMs;
        if (maxWait !== undefined && waitMs > maxWait) {
          throw new AllProfilesExhaustedError(attempts);
        }

        this.logger?.warn?.(
          `[${opts?.label ?? "llm-failover"}] All profiles in cooldown, waiting ${Math.round(waitMs / 1000)}s`,
        );
        await this.sleep(waitMs, opts?.signal);
        continue;
      }

      const ctx: ProfileContext = {
        profileId: candidate.id,
        apiKey: candidate.apiKey,
        provider: candidate.provider,
        model: candidate.model ?? opts?.model ?? "unknown",
      };

      try {
        const value = await task(ctx);
        await this.markSuccess(candidate.id);
        return {
          value,
          profileId: candidate.id,
          provider: ctx.provider,
          model: ctx.model,
          attempts,
        };
      } catch (err: unknown) {
        // Non-timeout abort → rethrow immediately
        if (isNonTimeoutAbort(err)) {
          throw err;
        }

        const reason = classifyError(err);
        const errorMsg = err instanceof Error ? err.message : String(err);

        attempts.push({
          profileId: candidate.id,
          provider: ctx.provider,
          model: ctx.model,
          error: errorMsg,
          reason,
        });

        await this.markFailure(candidate.id, reason);
        this.logger?.warn?.(
          `[${opts?.label ?? "llm-failover"}] Profile ${candidate.id} failed: ${reason} — ${errorMsg}`,
        );
      }
    }

    throw new AllProfilesExhaustedError(attempts);
  }

  async markFailure(profileId: string, reason: FailureReason): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) return;

    const now = Date.now();

    // Window immutability: if there's an active cooldown, don't extend it
    // But still track the failure for proper escalation when cooldown expires
    if (profile.cooldownUntil && profile.cooldownUntil > now) {
      profile.errorCount++;
      profile.lastFailure = now;
      profile.lastFailureReason = reason;
      await this.persist();
      return;
    }

    // Failure window decay: reset errorCount if last failure was too long ago
    if (
      profile.lastFailure &&
      now - profile.lastFailure > this.cooldownConfig.failureWindowMs
    ) {
      profile.errorCount = 0;
    }

    profile.errorCount++;
    profile.lastFailure = now;
    profile.lastFailureReason = reason;

    const cooldownMs = computeCooldownMs(profile.errorCount, reason, this.cooldownConfig);
    profile.cooldownUntil = now + cooldownMs;

    this.logger?.info?.(
      `Profile ${profileId} in cooldown for ${Math.round(cooldownMs / 1000)}s (errorCount=${profile.errorCount}, reason=${reason})`,
    );

    await this.persist();
  }

  async markSuccess(profileId: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) return;

    const now = Date.now();
    profile.lastUsed = now;
    profile.lastSuccess = now;
    // Don't reset errorCount on success — the cooldown math handles decay via failureWindowMs
    // But do clear any active cooldown
    profile.cooldownUntil = undefined;

    await this.persist();
  }

  isInCooldown(profileId: string): boolean {
    const profile = this.profiles.get(profileId);
    if (!profile) return false;
    if (!profile.cooldownUntil) return false;
    return profile.cooldownUntil > Date.now();
  }

  async clearCooldown(profileId: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) return;
    profile.cooldownUntil = undefined;
    profile.errorCount = 0;
    await this.persist();
  }

  getStatus(): PoolStatus {
    const now = Date.now();
    const profileStatuses: PoolStatus["profiles"] = [];
    let totalAvailable = 0;
    let totalInCooldown = 0;
    let lastUnavailableReason: FailureReason | null = null;

    const allIds = [...this.profileOrder, ...this.fallbackOrder];
    for (const id of allIds) {
      const p = this.profiles.get(id)!;
      let state: "available" | "cooldown" | "disabled";
      if (p.cooldownUntil && p.cooldownUntil > now) {
        if (isBillingReason(p.lastFailureReason!)) {
          state = "disabled";
        } else {
          state = "cooldown";
          totalInCooldown++;
        }
        lastUnavailableReason = p.lastFailureReason ?? null;
      } else {
        state = "available";
        totalAvailable++;
      }

      profileStatuses.push({
        id: p.id,
        provider: p.provider,
        model: p.model,
        state,
        cooldownUntil: p.cooldownUntil,
        errorCount: p.errorCount,
        lastUsed: p.lastUsed,
        lastFailure: p.lastFailure,
      });
    }

    return {
      profiles: profileStatuses,
      totalAvailable,
      totalInCooldown,
      unavailableReason: totalAvailable === 0 ? lastUnavailableReason : null,
    };
  }

  // ── Private ──────────────────────────────────────────────

  private buildCandidates(
    opts?: RunOptions,
  ): Array<{ profileId: string; priority: number }> {
    const candidates: Array<{ profileId: string; priority: number }> = [];

    // Primary profiles: preferred provider first (priority 0), others second (priority 1)
    for (const id of this.profileOrder) {
      const p = this.profiles.get(id)!;
      if (opts?.provider && p.provider !== opts.provider) {
        candidates.push({ profileId: id, priority: 1 });
      } else {
        candidates.push({ profileId: id, priority: 0 });
      }
    }

    // Fallback profiles (priority 2)
    for (const id of this.fallbackOrder) {
      candidates.push({ profileId: id, priority: 2 });
    }

    return candidates;
  }

  private pickCandidate(
    candidates: Array<{ profileId: string; priority: number }>,
  ): ProfileState | null {
    const now = Date.now();

    // Group available candidates by priority
    const groups = new Map<number, Array<{ profile: ProfileState; candidateIndex: number }>>();

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const p = this.profiles.get(c.profileId);
      if (!p) continue;
      if (p.cooldownUntil && p.cooldownUntil > now) continue;

      if (!groups.has(c.priority)) groups.set(c.priority, []);
      groups.get(c.priority)!.push({ profile: p, candidateIndex: i });
    }

    // Pick from lowest priority number first (0 = preferred provider, 1 = other, 2 = fallback)
    const priorities = [...groups.keys()].sort((a, b) => a - b);
    for (const priority of priorities) {
      const group = groups.get(priority)!;
      if (group.length === 0) continue;

      // Round-robin: sort by lastUsed ascending (never-used profiles first)
      group.sort((a, b) => {
        const aLastUsed = a.profile.lastUsed ?? -1;
        const bLastUsed = b.profile.lastUsed ?? -1;
        if (aLastUsed !== bLastUsed) return aLastUsed - bLastUsed;
        return a.candidateIndex - b.candidateIndex;
      });

      return group[0]!.profile;
    }

    return null;
  }

  private soonestCooldownWait(): number | null {
    const now = Date.now();
    let soonest = Infinity;
    let hasCooldown = false;

    for (const p of this.profiles.values()) {
      if (p.cooldownUntil && p.cooldownUntil > now) {
        hasCooldown = true;
        soonest = Math.min(soonest, p.cooldownUntil - now);
      }
    }

    return hasCooldown ? soonest : null;
  }

  private async persist(): Promise<void> {
    if (!this.storagePath) return;
    try {
      await saveState(this.storagePath, this.profiles, this.logger);
    } catch (err) {
      this.logger?.error?.(`Failed to persist state: ${err}`);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true },
      );
    });
  }
}
