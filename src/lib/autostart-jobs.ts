/**
 * Potato worker config JSON + autostart round-robin helpers (unit-testable).
 */
import { access, readFile, stat } from "node:fs/promises";
import type { SiteSpeedTestInput } from "../shared/types";

export type AutostartState = {
  nextIndex: number;
};

/**
 * Root config object at CONFIG_PATH (default config.json).
 * `autostart` is the round-robin job list; more top-level keys can be added later.
 */
export type PotatoConfig = {
  autostart: SiteSpeedTestInput[];
};

export type LoadedPotatoConfig = {
  config: PotatoConfig;
  /** Convenience alias for config.autostart */
  jobs: SiteSpeedTestInput[];
  mtimeMs: number;
  /** True when the on-disk file changed since the previous successful load. */
  reloaded: boolean;
  path: string;
};

export function parseAutostartJobs(raw: unknown): SiteSpeedTestInput[] {
  if (!Array.isArray(raw)) {
    throw new Error("config.autostart must be a JSON array");
  }
  const jobs: SiteSpeedTestInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      throw new Error(`config.autostart[${i}] must be an object`);
    }
    const o = item as Record<string, unknown>;
    const metricPrefix =
      typeof o.metricPrefix === "string" ? o.metricPrefix.trim() : "";
    const country = typeof o.country === "string" ? o.country.trim() : "";
    const tld = typeof o.tld === "string" ? o.tld.trim() : "";
    if (!metricPrefix || !country || !tld) {
      throw new Error(
        `config.autostart[${i}] requires metricPrefix, country, and tld`,
      );
    }
    jobs.push(item as SiteSpeedTestInput);
  }
  return jobs;
}

export function parsePotatoConfig(raw: unknown): PotatoConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "config must be a JSON object with an autostart array (not a bare array)",
    );
  }
  const o = raw as Record<string, unknown>;
  if (!("autostart" in o)) {
    throw new Error("config.autostart is required");
  }
  return { autostart: parseAutostartJobs(o.autostart) };
}

export function parseAutostartState(raw: unknown): AutostartState {
  if (!raw || typeof raw !== "object") {
    return { nextIndex: 0 };
  }
  const n = (raw as { nextIndex?: unknown }).nextIndex;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    return { nextIndex: 0 };
  }
  return { nextIndex: Math.floor(n) };
}

/** Clamp index into [0, length). */
export function clampAutostartIndex(nextIndex: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(nextIndex) || nextIndex < 0) return 0;
  return Math.floor(nextIndex) % length;
}

/** Process-local cache so we can detect JSON edits without a worker restart. */
let configCache: {
  path: string;
  mtimeMs: number;
  config: PotatoConfig;
} | null = null;

/** Test helper — clear the in-process config cache. */
export function resetPotatoConfigCache(): void {
  configCache = null;
}

/** @deprecated use resetPotatoConfigCache */
export function resetAutostartJobsCache(): void {
  resetPotatoConfigCache();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load potato config from disk. Re-reads whenever the file mtime changes
 * (hot-reload). Returns null when the file is missing.
 */
export async function loadPotatoConfig(
  path: string,
): Promise<LoadedPotatoConfig | null> {
  if (!(await fileExists(path))) {
    if (configCache?.path === path) configCache = null;
    return null;
  }

  const st = await stat(path);
  const mtimeMs = st.mtimeMs;

  if (
    configCache &&
    configCache.path === path &&
    configCache.mtimeMs === mtimeMs
  ) {
    return {
      config: configCache.config,
      jobs: configCache.config.autostart,
      mtimeMs,
      reloaded: false,
      path,
    };
  }

  const text = await readFile(path, "utf8");
  const config = parsePotatoConfig(JSON.parse(text) as unknown);
  const reloaded =
    configCache !== null &&
    (configCache.path !== path || configCache.mtimeMs !== mtimeMs);

  configCache = { path, mtimeMs, config };
  return {
    config,
    jobs: config.autostart,
    mtimeMs,
    reloaded,
    path,
  };
}

/** @deprecated use loadPotatoConfig */
export async function loadAutostartJobs(
  path: string,
): Promise<LoadedPotatoConfig | null> {
  return loadPotatoConfig(path);
}
