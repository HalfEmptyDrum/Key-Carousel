# llm-failover

Resilient LLM key pool with cooldown rotation and automatic failover.

## Why?

If you run multiple LLM agents or services, you've hit this: one API key gets rate-limited and your whole system stalls. You add a second key, manually swap them, and pray.

This library solves that. It manages a pool of API keys across providers, automatically rotates when one fails, applies exponential-backoff cooldowns so you don't hammer a recovering endpoint, and falls back to alternative providers/models when all keys for a provider are exhausted.

Distilled from a production AI gateway running dozens of agents continuously.

## Quick Start

```ts
import { LlmKeyPool } from "llm-failover";

const pool = new LlmKeyPool({
  profiles: [
    { id: "anthropic-1", provider: "anthropic", apiKey: process.env.ANTHROPIC_KEY_1! },
    { id: "anthropic-2", provider: "anthropic", apiKey: process.env.ANTHROPIC_KEY_2! },
    { id: "openai-1", provider: "openai", apiKey: process.env.OPENAI_KEY_1! },
    { id: "openai-2", provider: "openai", apiKey: process.env.OPENAI_KEY_2! },
    { id: "gemini-1", provider: "gemini", apiKey: process.env.GEMINI_KEY_1! },
  ],
  fallbackModels: [
    { provider: "openai", model: "gpt-4o" },
    { provider: "gemini", model: "gemini-1.5-pro" },
  ],
  storagePath: "./llm-pool-state.json", // optional: persist across restarts
});

// Optional: load persisted state
await pool.init();

// Use it — the pool handles rotation and failover
const result = await pool.run(
  async (ctx) => {
    // ctx.apiKey, ctx.provider, ctx.model are ready to use
    const response = await callYourLlm(ctx);
    return response;
  },
  { model: "claude-sonnet-4-20250514", provider: "anthropic", label: "summarize" },
);

console.log(result.value); // your LLM response
console.log(result.attempts); // [] on first-try success, or list of failed attempts
```

## Cooldown Schedule

Cooldowns use exponential backoff to avoid hammering failing endpoints.

### Rate Limit / Transient Errors

| Error # | Cooldown | Formula |
|---------|----------|---------|
| 1st | 1 min | 60s * 5^0 |
| 2nd | 5 min | 60s * 5^1 |
| 3rd | 25 min | 60s * 5^2 |
| 4th+ | 1 hr (max) | capped |

### Billing / Auth-Permanent Errors

| Error # | Cooldown | Formula |
|---------|----------|---------|
| 1st | 5 hr | 5hr * 2^0 |
| 2nd | 10 hr | 5hr * 2^1 |
| 3rd | 20 hr | 5hr * 2^2 |
| 4th+ | 24 hr (max) | capped |

## Error Classification

The `classifyError` helper maps errors to failure reasons:

```ts
import { classifyError } from "llm-failover";

const reason = classifyError(error);
// "rate_limit" | "auth" | "auth_permanent" | "billing" | "timeout" | "model_not_found" | "format" | "unknown"
```

Classification sources:
- **HTTP status**: 401 -> auth, 402 -> billing, 403 -> auth_permanent, 404 -> model_not_found, 429 -> rate_limit
- **Message patterns**: "rate limit", "billing", "quota exceeded", "timeout", etc.
- **Error types**: `AbortError` -> timeout, `FailoverError` -> uses its `.failureReason`

## Explicit Retryable Errors

Throw `FailoverError` from your task to explicitly signal "retry with next profile":

```ts
import { FailoverError } from "llm-failover";

const result = await pool.run(async (ctx) => {
  const res = await fetch(/* ... */);
  if (res.status === 503) {
    throw new FailoverError("Service unavailable", { reason: "unknown" });
  }
  return res.json();
});
```

## Pool Status

```ts
const status = pool.getStatus();

for (const p of status.profiles) {
  console.log(`${p.id}: ${p.state}`);
  // state: "available" | "cooldown" | "disabled"
  // cooldownUntil: ms epoch when cooldown expires
  // errorCount: consecutive errors in current failure window
}

console.log(`Available: ${status.totalAvailable}`);
console.log(`In cooldown: ${status.totalInCooldown}`);
if (status.unavailableReason) {
  console.log(`All unavailable due to: ${status.unavailableReason}`);
}
```

## Persistence

Pass `storagePath` to persist cooldown state across process restarts:

```ts
const pool = new LlmKeyPool({
  profiles: [/* ... */],
  storagePath: "/var/data/llm-pool-state.json",
});
await pool.init(); // loads from disk
```

State is saved atomically (write-to-temp + rename) after every failure/success. A simple file lock handles concurrent processes sharing the same state file.

If the file is missing or corrupt, the pool starts fresh and logs a warning.

## Configuration

```ts
const pool = new LlmKeyPool({
  profiles: [/* ... */],
  cooldowns: {
    maxRateLimitCooldownMs: 3_600_000,  // max cooldown for rate limits (default: 1hr)
    billingBackoffMs: 18_000_000,        // base cooldown for billing errors (default: 5hr)
    billingMaxMs: 86_400_000,            // max cooldown for billing errors (default: 24hr)
    failureWindowMs: 86_400_000,         // errors older than this are forgotten (default: 24hr)
  },
  logger: console, // or any object with debug/info/warn/error methods
});
```

## Should I Use This vs LiteLLM?

| | llm-failover | LiteLLM |
|---|---|---|
| **Architecture** | In-process library | Separate proxy process |
| **Infrastructure** | Zero | Requires running a proxy server |
| **Language** | TypeScript-native, ESM | Python |
| **Key rotation** | Built-in with exponential backoff | Basic fallback |
| **Cooldown math** | Graduated: 1min, 5min, 25min, 1hr | Fixed retry delays |
| **Billing errors** | Separate long disable window (5hr-24hr) | Same as other errors |
| **Persistence** | Optional file-based state | Requires database |
| **Bundle size** | Zero dependencies | Heavy Python deps |

Use **this library** when you want TypeScript-native key rotation with zero infrastructure. Use **LiteLLM** when you need a language-agnostic proxy with a broader feature set.

## License

MIT
