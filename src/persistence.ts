import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger, PersistedState, ProfileState } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 20;

/**
 * Acquire an exclusive file lock using O_EXCL (atomic create-or-fail).
 * Returns a release function.
 */
async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  let retries = 0;
  while (retries < LOCK_MAX_RETRIES) {
    try {
      const fd = await open(lockPath, "wx");
      await fd.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // lock file already removed — fine
        }
      };
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        retries++;
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS * retries));
        continue;
      }
      throw err;
    }
  }
  // After max retries, forcefully remove the stale lock and try once more
  try {
    await unlink(lockPath);
  } catch {
    // ignore
  }
  const fd = await open(lockPath, "wx");
  await fd.close();
  return async () => {
    try {
      await unlink(lockPath);
    } catch {
      // ignore
    }
  };
}

export async function loadState(
  storagePath: string,
  logger?: Logger,
): Promise<PersistedState | null> {
  try {
    const raw = await readFile(storagePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      (parsed as PersistedState).version === 1
    ) {
      return parsed as PersistedState;
    }
    logger?.warn?.("Persisted state has unexpected format, starting fresh");
    return null;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null; // file doesn't exist yet
    }
    logger?.warn?.(`Failed to load persisted state: ${err}`);
    return null;
  }
}

export async function saveState(
  storagePath: string,
  profiles: Map<string, ProfileState>,
  _logger?: Logger,
): Promise<void> {
  const lockPath = storagePath + ".lock";
  const release = await acquireLock(lockPath);
  try {
    const state: PersistedState = {
      version: 1,
      profiles: {},
    };
    for (const [id, p] of profiles) {
      state.profiles[id] = {
        errorCount: p.errorCount,
        lastUsed: p.lastUsed,
        lastFailure: p.lastFailure,
        lastSuccess: p.lastSuccess,
        cooldownUntil: p.cooldownUntil,
        lastFailureReason: p.lastFailureReason,
      };
    }
    const tmpPath = join(dirname(storagePath), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmpPath, storagePath);
  } finally {
    await release();
  }
}

export function applyPersistedState(
  profiles: Map<string, ProfileState>,
  persisted: PersistedState,
): void {
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
