import { classifyError, isNonTimeoutAbort } from "./classify.js";
import { computeCooldownMs, isBillingReason, resolvedConfig } from "./cooldown.js";
import { AllProfilesExhaustedError } from "./errors.js";
import { applyPersistedState, loadState, saveState } from "./persistence.js";
import type {
  CooldownConfig,
  FailedAttempt,
  FailureReason,
  FallbackModelDefinition,
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
  private readonly fallbackModels: FallbackModelDefinition[];
  private readonly storagePath?: string;
  private readonly cooldownConfig: Required<CooldownConfig>;
  private readonly logger?: Logger;

  constructor(config: LlmKeyPoolConfig) {
    this.fallbackModels = config.fallbackModels ?? [];
    this.storagePath = config.storagePath;
    this.cooldownConfig = resolvedConfig(config.cooldowns);
    this.logger = config.logger;

    let idx = 0;
    for (const def of config.profiles) {
      const id = def.id ?? `profile-${idx}`;
      this.profiles.set(id, {
        id,
        provider: def.provider,
        model: def.model,
        apiKey: def.apiKey,
        weight: def.weight ?? 1,
        errorCount: 0,
      });
      this.profileOrder.push(id);
      idx++;
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

      const candidate = this.pickCandidate(candidates, opts);

      if (!candidate) {
        // All profiles in cooldown — wait for soonest expiry
        const waitMs = this.soonestCooldownWait();
        if (waitMs === null) {
          // All permanently disabled
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
    if (profile.cooldownUntil && profile.cooldownUntil > now) {
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

    for (const id of this.profileOrder) {
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
  ): Array<{ profileId: string; fallbackModel?: FallbackModelDefinition }> {
    // Primary profiles matching the requested provider
    const candidates: Array<{ profileId: string; fallbackModel?: FallbackModelDefinition }> = [];

    for (const id of this.profileOrder) {
      const p = this.profiles.get(id)!;
      if (opts?.provider && p.provider !== opts.provider) continue;
      candidates.push({ profileId: id });
    }

    // Also include profiles not matching provider (lower priority)
    for (const id of this.profileOrder) {
      const p = this.profiles.get(id)!;
      if (!opts?.provider || p.provider === opts.provider) continue;
      candidates.push({ profileId: id });
    }

    // Fallback models
    for (const fb of this.fallbackModels) {
      // Check if there's an existing profile for this fallback's provider
      const matchingProfile = this.profileOrder.find(
        (id) => this.profiles.get(id)!.provider === fb.provider,
      );
      if (matchingProfile || fb.apiKey) {
        candidates.push({
          profileId: matchingProfile ?? `fallback-${fb.provider}-${fb.model}`,
          fallbackModel: fb,
        });
      }
    }

    return candidates;
  }

  private pickCandidate(
    candidates: Array<{ profileId: string; fallbackModel?: FallbackModelDefinition }>,
    opts?: RunOptions,
  ): (ProfileState & { model?: string }) | null {
    const now = Date.now();

    // Resolve profile ordering among available candidates
    const available: ProfileState[] = [];
    for (const c of candidates) {
      const p = this.profiles.get(c.profileId);
      if (!p) {
        // Fallback with its own apiKey that doesn't match existing profile
        if (c.fallbackModel?.apiKey) {
          // Create an ephemeral profile state
          const ephemeral: ProfileState = {
            id: c.profileId,
            provider: c.fallbackModel.provider,
            model: c.fallbackModel.model,
            apiKey: c.fallbackModel.apiKey,
            weight: 1,
            errorCount: 0,
          };
          available.push(ephemeral);
        }
        continue;
      }
      if (p.cooldownUntil && p.cooldownUntil > now) continue;

      // If this candidate has a fallback model override, create a view with that model
      if (c.fallbackModel) {
        available.push({
          ...p,
          model: c.fallbackModel.model,
          apiKey: c.fallbackModel.apiKey ?? p.apiKey,
        });
      } else {
        available.push(p);
      }
    }

    if (available.length === 0) return null;

    // Sort by priority tier then round-robin
    return this.sortByPriority(available, opts);
  }

  /**
   * Profile ordering algorithm:
   * 1. Tier 1: used recently AND succeeded — sorted by lastUsed (oldest first for round-robin)
   * 2. Tier 2: never used or no errors — sorted by index for stability
   * 3. Within each tier, pick the profile with the oldest lastUsed (round-robin)
   */
  private sortByPriority(
    profiles: ProfileState[],
    _opts?: RunOptions,
  ): ProfileState {
    const tier1: ProfileState[] = [];
    const tier2: ProfileState[] = [];

    for (const p of profiles) {
      if (p.lastSuccess && p.lastUsed) {
        tier1.push(p);
      } else {
        tier2.push(p);
      }
    }

    // Tier 1: round-robin — pick oldest lastUsed
    tier1.sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
    // Tier 2: stable order by index in profileOrder
    tier2.sort(
      (a, b) => this.profileOrder.indexOf(a.id) - this.profileOrder.indexOf(b.id),
    );

    // Tier 1 has priority, pick from it first (oldest lastUsed = round-robin)
    if (tier1.length > 0) return tier1[0]!;
    return tier2[0]!;
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
