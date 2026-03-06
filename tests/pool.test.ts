import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LlmKeyPool,
  FailoverError,
  AllProfilesExhaustedError,
  classifyError,
} from "../src/index.js";
import type { LlmKeyPoolConfig, ProfileContext } from "../src/index.js";

function makePool(overrides?: Partial<LlmKeyPoolConfig>): LlmKeyPool {
  return new LlmKeyPool({
    profiles: [
      { id: "a", provider: "anthropic", apiKey: "key-a" },
      { id: "b", provider: "anthropic", apiKey: "key-b" },
      { id: "c", provider: "openai", apiKey: "key-c" },
    ],
    ...overrides,
  });
}

describe("LlmKeyPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic success ─────────────────────────────────

  it("successful first attempt returns result and empty attempts", async () => {
    const pool = makePool();
    const result = await pool.run(async (ctx) => {
      expect(ctx.apiKey).toBeTruthy();
      return "hello";
    });

    expect(result.value).toBe("hello");
    expect(result.attempts).toHaveLength(0);
    expect(result.profileId).toBe("a");
    expect(result.provider).toBe("anthropic");
  });

  // ── Failover to next profile ──────────────────────

  it("failed profile enters cooldown, second profile is used on next call", async () => {
    const pool = makePool();
    let callCount = 0;

    const result = await pool.run(async (ctx) => {
      callCount++;
      if (ctx.profileId === "a") {
        const err = new Error("rate limit exceeded");
        (err as Record<string, unknown>)["status"] = 429;
        throw err;
      }
      return "from-b";
    });

    expect(callCount).toBe(2);
    expect(result.value).toBe("from-b");
    expect(result.profileId).toBe("b");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.profileId).toBe("a");
    expect(result.attempts[0]!.reason).toBe("rate_limit");

    // Profile "a" is now in cooldown
    expect(pool.isInCooldown("a")).toBe(true);
  });

  // ── Cooldown expiry ───────────────────────────────

  it("after cooldown expiry, profile is eligible again", async () => {
    const pool = makePool();

    // Fail profile "a"
    await pool.run(async (ctx) => {
      if (ctx.profileId === "a") {
        const err = new Error("rate limit");
        (err as Record<string, unknown>)["status"] = 429;
        throw err;
      }
      return "ok";
    });

    expect(pool.isInCooldown("a")).toBe(true);

    // Advance past 1-minute cooldown (first error = 60s)
    vi.advanceTimersByTime(61_000);

    expect(pool.isInCooldown("a")).toBe(false);

    // Now profile "a" should be available again
    // But "b" was last successful, so it may be picked first (tier 1)
    // "a" is tier 2 (never succeeded). Let's verify "a" is at least not excluded
    const status = pool.getStatus();
    const profileA = status.profiles.find((p) => p.id === "a");
    expect(profileA!.state).toBe("available");
  });

  // ── Billing failure uses longer disable ───────────

  it("billing failure uses longer disable window than rate limit", async () => {
    const pool = makePool();

    // Fail with billing error
    await pool.markFailure("a", "billing");

    const status = pool.getStatus();
    const profileA = status.profiles.find((p) => p.id === "a");
    expect(profileA!.state).toBe("disabled");
    // First billing error: 5hr cooldown
    expect(profileA!.cooldownUntil).toBe(Date.now() + 18_000_000);

    // Rate limit would only be 1 min
    await pool.markFailure("b", "rate_limit");
    const profileB = status.profiles.find((p) => p.id === "b");
    // Need to refresh status
    const status2 = pool.getStatus();
    const profileB2 = status2.profiles.find((p) => p.id === "b");
    expect(profileB2!.state).toBe("cooldown");
    expect(profileB2!.cooldownUntil).toBe(Date.now() + 60_000);
  });

  // ── All profiles exhausted ────────────────────────

  it("all profiles in cooldown: throws with descriptive summary", async () => {
    const pool = makePool({
      profiles: [
        { id: "a", provider: "anthropic", apiKey: "key-a" },
      ],
    });

    // Task always fails
    const promise = pool.run(async () => {
      const err = new Error("rate limit");
      (err as Record<string, unknown>)["status"] = 429;
      throw err;
    });

    // Attach rejection handler immediately to prevent unhandled rejection warning
    const assertion = expect(promise).rejects.toThrow(AllProfilesExhaustedError);

    // The pool tries profile "a", it fails (60s cooldown), then loops.
    // maxIterations = max(32, 24 + 1*8) = 32
    // Advance fake timers so sleep() calls resolve.
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(3_700_000);
    }

    await assertion;
  }, 30_000);

  // ── AbortError propagation ────────────────────────

  it("AbortError (non-timeout) propagates immediately without trying next profile", async () => {
    const pool = makePool();
    let callCount = 0;

    const abortError = new DOMException("The operation was aborted.", "AbortError");

    await expect(
      pool.run(async () => {
        callCount++;
        throw abortError;
      }),
    ).rejects.toThrow("The operation was aborted.");

    expect(callCount).toBe(1); // Only tried once, did not failover
  });

  // ── FailoverError triggers fallback ───────────────

  it("FailoverError triggers fallback to next profile", async () => {
    const pool = makePool();
    let callCount = 0;

    const result = await pool.run(async (ctx) => {
      callCount++;
      if (ctx.profileId === "a") {
        throw new FailoverError("bad gateway", { reason: "unknown" });
      }
      return "ok";
    });

    expect(callCount).toBe(2);
    expect(result.profileId).toBe("b");
  });

  // ── Profile ordering: last-good first ─────────────

  it("profileOrder: last-good profiles come first", async () => {
    const pool = makePool();

    // Use profile "a" successfully
    await pool.run(async (ctx) => {
      if (ctx.profileId !== "a") throw new FailoverError("skip", { reason: "unknown" });
      return "ok";
    });

    // Use profile "b" successfully — advance time so "b" is more recent
    vi.advanceTimersByTime(1000);
    await pool.markSuccess("b");

    // Now "a" should be picked (oldest lastUsed in tier 1 = round-robin)
    vi.advanceTimersByTime(1000);
    const result = await pool.run(async () => "got-it");
    expect(result.profileId).toBe("a");
  });

  // ── Round-robin among equal tier ──────────────────

  it("profileOrder: round-robin among equal-tier profiles", async () => {
    const pool = makePool();

    // time=0: First call picks "a" (tier 2, stable order). a.lastUsed=0
    const r1 = await pool.run(async () => "ok");
    expect(r1.profileId).toBe("a");

    // Make "b" a tier-1 profile too via markSuccess
    vi.advanceTimersByTime(1000); // time=1000
    await pool.markSuccess("b"); // b.lastUsed=1000

    // time=2000: Tier 1 has a(lastUsed=0) and b(lastUsed=1000). Oldest = "a".
    vi.advanceTimersByTime(1000);
    const r2 = await pool.run(async () => "ok");
    expect(r2.profileId).toBe("a"); // picks "a" (oldest lastUsed)
    // After success: a.lastUsed=2000

    // time=3000: Tier 1 has a(lastUsed=2000) and b(lastUsed=1000). Oldest = "b".
    vi.advanceTimersByTime(1000);
    const r3 = await pool.run(async () => "ok");
    expect(r3.profileId).toBe("b"); // picks "b" (oldest lastUsed)
    // After success: b.lastUsed=3000

    // time=4000: Tier 1 has a(lastUsed=2000) and b(lastUsed=3000). Oldest = "a".
    vi.advanceTimersByTime(1000);
    const r4 = await pool.run(async () => "ok");
    expect(r4.profileId).toBe("a"); // round-robin back to "a"
  });

  // ── Failure window decay ──────────────────────────

  it("errorCount reset after failureWindowMs", async () => {
    const pool = makePool({
      profiles: [{ id: "x", provider: "anthropic", apiKey: "key-x" }],
      cooldowns: { failureWindowMs: 120_000 }, // 2 min window
    });

    // First failure → errorCount=1, cooldown=60s
    await pool.markFailure("x", "rate_limit");
    expect(pool.isInCooldown("x")).toBe(true);

    // Wait past cooldown (60s) but within failure window (120s)
    vi.advanceTimersByTime(61_000);
    expect(pool.isInCooldown("x")).toBe(false);

    // Second failure → errorCount=2 (within window), cooldown=5min
    await pool.markFailure("x", "rate_limit");
    const status = pool.getStatus();
    const px = status.profiles[0]!;
    expect(px.errorCount).toBe(2);

    // Wait past cooldown (5min) AND past failure window (2min from last failure)
    vi.advanceTimersByTime(300_001); // 5min+1ms past the cooldown, also 5min past last failure > 2min window

    // Now failure window has passed → errorCount should reset
    await pool.markFailure("x", "rate_limit");
    const status2 = pool.getStatus();
    expect(status2.profiles[0]!.errorCount).toBe(1); // reset to 0, then incremented to 1
  });

  // ── Window immutability ───────────────────────────

  it("existing active cooldown window is not extended by additional failures within it", async () => {
    const pool = makePool({
      profiles: [{ id: "x", provider: "anthropic", apiKey: "key-x" }],
    });

    await pool.markFailure("x", "rate_limit");
    const status1 = pool.getStatus();
    const originalCooldown = status1.profiles[0]!.cooldownUntil!;

    // Try to mark another failure while still in cooldown
    vi.advanceTimersByTime(10_000); // 10s into the 60s cooldown
    await pool.markFailure("x", "rate_limit");

    const status2 = pool.getStatus();
    // Cooldown should NOT have been extended
    expect(status2.profiles[0]!.cooldownUntil).toBe(originalCooldown);
    expect(status2.profiles[0]!.errorCount).toBe(1); // didn't increment
  });

  // ── Persistence ───────────────────────────────────

  it("storagePath: state persists and reloads correctly", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "llm-failover-test-"));
    const storagePath = join(tmpDir, "state.json");

    try {
      const pool1 = new LlmKeyPool({
        profiles: [
          { id: "a", provider: "anthropic", apiKey: "key-a" },
          { id: "b", provider: "openai", apiKey: "key-b" },
        ],
        storagePath,
      });
      await pool1.init();

      // Use real timers for file I/O
      vi.useRealTimers();

      await pool1.markFailure("a", "rate_limit");
      await pool1.markSuccess("b");

      // Read persisted file
      const raw = await readFile(storagePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.profiles.a.errorCount).toBe(1);
      expect(parsed.profiles.b.lastSuccess).toBeTruthy();

      // Create new pool from same file
      const pool2 = new LlmKeyPool({
        profiles: [
          { id: "a", provider: "anthropic", apiKey: "key-a" },
          { id: "b", provider: "openai", apiKey: "key-b" },
        ],
        storagePath,
      });
      await pool2.init();

      const status = pool2.getStatus();
      expect(status.profiles.find((p) => p.id === "a")!.errorCount).toBe(1);

      vi.useFakeTimers();
    } finally {
      vi.useRealTimers();
      await rm(tmpDir, { recursive: true, force: true });
      vi.useFakeTimers();
    }
  });

  // ── getStatus ─────────────────────────────────────

  it("getStatus() returns correct state for available/cooldown/disabled profiles", async () => {
    const pool = makePool();

    // Initially all available
    let status = pool.getStatus();
    expect(status.totalAvailable).toBe(3);
    expect(status.totalInCooldown).toBe(0);
    expect(status.unavailableReason).toBeNull();

    // Put one in cooldown
    await pool.markFailure("a", "rate_limit");
    status = pool.getStatus();
    expect(status.totalAvailable).toBe(2);
    expect(status.totalInCooldown).toBe(1);
    expect(status.profiles.find((p) => p.id === "a")!.state).toBe("cooldown");
    expect(status.unavailableReason).toBeNull();

    // Put one in disabled
    await pool.markFailure("b", "billing");
    status = pool.getStatus();
    expect(status.profiles.find((p) => p.id === "b")!.state).toBe("disabled");
    expect(status.totalAvailable).toBe(1);
  });
});

// ── classifyError ─────────────────────────────────────

describe("classifyError", () => {
  it("classifies HTTP 429 as rate_limit", () => {
    const err = new Error("too many requests");
    (err as Record<string, unknown>)["status"] = 429;
    expect(classifyError(err)).toBe("rate_limit");
  });

  it("classifies HTTP 401 as auth", () => {
    const err = new Error("unauthorized");
    (err as Record<string, unknown>)["status"] = 401;
    expect(classifyError(err)).toBe("auth");
  });

  it("classifies HTTP 403 as auth_permanent", () => {
    const err = new Error("forbidden");
    (err as Record<string, unknown>)["status"] = 403;
    expect(classifyError(err)).toBe("auth_permanent");
  });

  it("classifies HTTP 402 as billing", () => {
    const err = new Error("payment required");
    (err as Record<string, unknown>)["status"] = 402;
    expect(classifyError(err)).toBe("billing");
  });

  it("classifies HTTP 404 as model_not_found", () => {
    const err = new Error("not found");
    (err as Record<string, unknown>)["status"] = 404;
    expect(classifyError(err)).toBe("model_not_found");
  });

  it("classifies HTTP 400 as format", () => {
    const err = new Error("bad request");
    (err as Record<string, unknown>)["status"] = 400;
    expect(classifyError(err)).toBe("format");
  });

  it("classifies rate limit message pattern", () => {
    expect(classifyError(new Error("Rate limit exceeded"))).toBe("rate_limit");
  });

  it("classifies billing message pattern", () => {
    expect(classifyError(new Error("Billing quota exceeded"))).toBe("billing");
  });

  it("classifies timeout message pattern", () => {
    expect(classifyError(new Error("Request timed out"))).toBe("timeout");
  });

  it("classifies AbortError as timeout", () => {
    const err = new DOMException("signal", "AbortError");
    expect(classifyError(err)).toBe("timeout");
  });

  it("classifies FailoverError by its reason", () => {
    expect(classifyError(new FailoverError("oops", { reason: "rate_limit" }))).toBe("rate_limit");
  });

  it("defaults to unknown for unrecognized errors", () => {
    expect(classifyError(new Error("something weird"))).toBe("unknown");
  });
});
