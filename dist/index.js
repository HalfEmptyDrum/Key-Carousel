// src/errors.ts
var FailoverError = class extends Error {
  failureReason;
  isTimeout;
  constructor(message, opts) {
    super(message, { cause: opts?.cause });
    this.name = "FailoverError";
    this.failureReason = opts?.reason ?? "unknown";
    this.isTimeout = opts?.isTimeout ?? false;
  }
};
var AllProfilesExhaustedError = class extends Error {
  attempts;
  constructor(attempts) {
    const summary = attempts.map((a) => `  ${a.profileId} (${a.provider}/${a.model}): ${a.reason} \u2014 ${a.error}`).join("\n");
    super(`All LLM profiles exhausted after ${attempts.length} attempt(s):
${summary}`);
    this.name = "AllProfilesExhaustedError";
    this.attempts = attempts;
  }
};

// src/classify.ts
function classifyError(error) {
  if (error instanceof FailoverError) {
    return error.failureReason;
  }
  const status = extractStatus(error);
  if (status !== void 0) {
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
function extractStatus(error) {
  if (error && typeof error === "object") {
    const e = error;
    if (typeof e["status"] === "number") return e["status"];
    if (typeof e["statusCode"] === "number") return e["statusCode"];
    if (e["response"] && typeof e["response"] === "object") {
      const r = e["response"];
      if (typeof r["status"] === "number") return r["status"];
    }
  }
  return void 0;
}
function extractMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
function isAbortError(error) {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return false;
}
function isNonTimeoutAbort(error) {
  if (error instanceof FailoverError) {
    return false;
  }
  if (!isAbortError(error)) return false;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (/timeout|timed?.out/i.test(msg)) return false;
  }
  return true;
}

// src/cooldown.ts
var DEFAULTS = {
  maxRateLimitCooldownMs: 36e5,
  // 1hr
  billingBackoffMs: 18e6,
  // 5hr
  billingMaxMs: 864e5,
  // 24hr
  failureWindowMs: 864e5
  // 24hr
};
function resolvedConfig(config) {
  return { ...DEFAULTS, ...config };
}
function rateLimitCooldownMs(errorCount, maxMs) {
  const exp = Math.min(errorCount - 1, 3);
  return Math.min(maxMs, 6e4 * Math.pow(5, exp));
}
function billingDisableMs(errorCount, billingBackoffMs, billingMaxMs) {
  const exp = Math.min(errorCount - 1, 10);
  return Math.min(billingMaxMs, billingBackoffMs * Math.pow(2, exp));
}
function isBillingReason(reason) {
  return reason === "billing" || reason === "auth_permanent";
}
function computeCooldownMs(errorCount, reason, config) {
  if (isBillingReason(reason)) {
    return billingDisableMs(errorCount, config.billingBackoffMs, config.billingMaxMs);
  }
  return rateLimitCooldownMs(errorCount, config.maxRateLimitCooldownMs);
}

// src/persistence.ts
import { open, readFile, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
var LOCK_RETRY_MS = 50;
var LOCK_MAX_RETRIES = 20;
async function acquireLock(lockPath) {
  let retries = 0;
  while (retries < LOCK_MAX_RETRIES) {
    try {
      const fd2 = await open(lockPath, "wx");
      await fd2.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
        }
      };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        retries++;
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS * retries));
        continue;
      }
      throw err;
    }
  }
  try {
    await unlink(lockPath);
  } catch {
  }
  const fd = await open(lockPath, "wx");
  await fd.close();
  return async () => {
    try {
      await unlink(lockPath);
    } catch {
    }
  };
}
async function loadState(storagePath, logger) {
  try {
    const raw = await readFile(storagePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === 1) {
      return parsed;
    }
    logger?.warn?.("Persisted state has unexpected format, starting fresh");
    return null;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    logger?.warn?.(`Failed to load persisted state: ${err}`);
    return null;
  }
}
async function saveState(storagePath, profiles, _logger) {
  const lockPath = storagePath + ".lock";
  const release = await acquireLock(lockPath);
  try {
    const state = {
      version: 1,
      profiles: {}
    };
    for (const [id, p] of profiles) {
      state.profiles[id] = {
        errorCount: p.errorCount,
        lastUsed: p.lastUsed,
        lastFailure: p.lastFailure,
        lastSuccess: p.lastSuccess,
        cooldownUntil: p.cooldownUntil,
        lastFailureReason: p.lastFailureReason
      };
    }
    const tmpPath = join(dirname(storagePath), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmpPath, storagePath);
  } finally {
    await release();
  }
}
function applyPersistedState(profiles, persisted) {
  for (const [id, data] of Object.entries(persisted.profiles)) {
    const profile = profiles.get(id);
    if (!profile) continue;
    profile.errorCount = data.errorCount;
    profile.lastUsed = data.lastUsed;
    profile.lastFailure = data.lastFailure;
    profile.lastSuccess = data.lastSuccess;
    profile.cooldownUntil = data.cooldownUntil;
    profile.lastFailureReason = data.lastFailureReason;
  }
}

// src/pool.ts
var LlmKeyPool = class {
  profiles = /* @__PURE__ */ new Map();
  profileOrder = [];
  fallbackModels;
  storagePath;
  cooldownConfig;
  logger;
  constructor(config) {
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
        errorCount: 0
      });
      this.profileOrder.push(id);
      idx++;
    }
  }
  /**
   * Initialize from persisted state. Call after construction if using storagePath.
   */
  async init() {
    if (!this.storagePath) return;
    const persisted = await loadState(this.storagePath, this.logger);
    if (persisted) {
      applyPersistedState(this.profiles, persisted);
      this.logger?.info?.("Loaded persisted state for " + this.profiles.size + " profiles");
    }
  }
  async run(task, opts) {
    const attempts = [];
    const profileCount = this.profiles.size;
    const maxIterations = Math.min(160, Math.max(32, 24 + profileCount * 8));
    const candidates = this.buildCandidates(opts);
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      const candidate = this.pickCandidate(candidates, opts);
      if (!candidate) {
        const waitMs = this.soonestCooldownWait();
        if (waitMs === null) {
          throw new AllProfilesExhaustedError(attempts);
        }
        this.logger?.warn?.(
          `[${opts?.label ?? "llm-failover"}] All profiles in cooldown, waiting ${Math.round(waitMs / 1e3)}s`
        );
        await this.sleep(waitMs, opts?.signal);
        continue;
      }
      const ctx = {
        profileId: candidate.id,
        apiKey: candidate.apiKey,
        provider: candidate.provider,
        model: candidate.model ?? opts?.model ?? "unknown"
      };
      try {
        const value = await task(ctx);
        await this.markSuccess(candidate.id);
        return {
          value,
          profileId: candidate.id,
          provider: ctx.provider,
          model: ctx.model,
          attempts
        };
      } catch (err) {
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
          reason
        });
        await this.markFailure(candidate.id, reason);
        this.logger?.warn?.(
          `[${opts?.label ?? "llm-failover"}] Profile ${candidate.id} failed: ${reason} \u2014 ${errorMsg}`
        );
      }
    }
    throw new AllProfilesExhaustedError(attempts);
  }
  async markFailure(profileId, reason) {
    const profile = this.profiles.get(profileId);
    if (!profile) return;
    const now = Date.now();
    if (profile.cooldownUntil && profile.cooldownUntil > now) {
      return;
    }
    if (profile.lastFailure && now - profile.lastFailure > this.cooldownConfig.failureWindowMs) {
      profile.errorCount = 0;
    }
    profile.errorCount++;
    profile.lastFailure = now;
    profile.lastFailureReason = reason;
    const cooldownMs = computeCooldownMs(profile.errorCount, reason, this.cooldownConfig);
    profile.cooldownUntil = now + cooldownMs;
    this.logger?.info?.(
      `Profile ${profileId} in cooldown for ${Math.round(cooldownMs / 1e3)}s (errorCount=${profile.errorCount}, reason=${reason})`
    );
    await this.persist();
  }
  async markSuccess(profileId) {
    const profile = this.profiles.get(profileId);
    if (!profile) return;
    const now = Date.now();
    profile.lastUsed = now;
    profile.lastSuccess = now;
    profile.cooldownUntil = void 0;
    await this.persist();
  }
  isInCooldown(profileId) {
    const profile = this.profiles.get(profileId);
    if (!profile) return false;
    if (!profile.cooldownUntil) return false;
    return profile.cooldownUntil > Date.now();
  }
  async clearCooldown(profileId) {
    const profile = this.profiles.get(profileId);
    if (!profile) return;
    profile.cooldownUntil = void 0;
    profile.errorCount = 0;
    await this.persist();
  }
  getStatus() {
    const now = Date.now();
    const profileStatuses = [];
    let totalAvailable = 0;
    let totalInCooldown = 0;
    let lastUnavailableReason = null;
    for (const id of this.profileOrder) {
      const p = this.profiles.get(id);
      let state;
      if (p.cooldownUntil && p.cooldownUntil > now) {
        if (isBillingReason(p.lastFailureReason)) {
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
        lastFailure: p.lastFailure
      });
    }
    return {
      profiles: profileStatuses,
      totalAvailable,
      totalInCooldown,
      unavailableReason: totalAvailable === 0 ? lastUnavailableReason : null
    };
  }
  // ── Private ──────────────────────────────────────────────
  buildCandidates(opts) {
    const candidates = [];
    for (const id of this.profileOrder) {
      const p = this.profiles.get(id);
      if (opts?.provider && p.provider !== opts.provider) continue;
      candidates.push({ profileId: id });
    }
    for (const id of this.profileOrder) {
      const p = this.profiles.get(id);
      if (!opts?.provider || p.provider === opts.provider) continue;
      candidates.push({ profileId: id });
    }
    for (const fb of this.fallbackModels) {
      const matchingProfile = this.profileOrder.find(
        (id) => this.profiles.get(id).provider === fb.provider
      );
      if (matchingProfile || fb.apiKey) {
        candidates.push({
          profileId: matchingProfile ?? `fallback-${fb.provider}-${fb.model}`,
          fallbackModel: fb
        });
      }
    }
    return candidates;
  }
  pickCandidate(candidates, opts) {
    const now = Date.now();
    const available = [];
    for (const c of candidates) {
      const p = this.profiles.get(c.profileId);
      if (!p) {
        if (c.fallbackModel?.apiKey) {
          const ephemeral = {
            id: c.profileId,
            provider: c.fallbackModel.provider,
            model: c.fallbackModel.model,
            apiKey: c.fallbackModel.apiKey,
            weight: 1,
            errorCount: 0
          };
          available.push(ephemeral);
        }
        continue;
      }
      if (p.cooldownUntil && p.cooldownUntil > now) continue;
      if (c.fallbackModel) {
        available.push({
          ...p,
          model: c.fallbackModel.model,
          apiKey: c.fallbackModel.apiKey ?? p.apiKey
        });
      } else {
        available.push(p);
      }
    }
    if (available.length === 0) return null;
    return this.sortByPriority(available, opts);
  }
  /**
   * Profile ordering algorithm:
   * 1. Tier 1: used recently AND succeeded — sorted by lastUsed (oldest first for round-robin)
   * 2. Tier 2: never used or no errors — sorted by index for stability
   * 3. Within each tier, pick the profile with the oldest lastUsed (round-robin)
   */
  sortByPriority(profiles, _opts) {
    const tier1 = [];
    const tier2 = [];
    for (const p of profiles) {
      if (p.lastSuccess && p.lastUsed) {
        tier1.push(p);
      } else {
        tier2.push(p);
      }
    }
    tier1.sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
    tier2.sort(
      (a, b) => this.profileOrder.indexOf(a.id) - this.profileOrder.indexOf(b.id)
    );
    if (tier1.length > 0) return tier1[0];
    return tier2[0];
  }
  soonestCooldownWait() {
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
  async persist() {
    if (!this.storagePath) return;
    try {
      await saveState(this.storagePath, this.profiles, this.logger);
    } catch (err) {
      this.logger?.error?.(`Failed to persist state: ${err}`);
    }
  }
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true }
      );
    });
  }
};
export {
  AllProfilesExhaustedError,
  FailoverError,
  LlmKeyPool,
  classifyError
};
//# sourceMappingURL=index.js.map