/** Shared types safe for Temporal workflows (deterministic, no I/O). */

export type PotatoTier = "stable" | "typical" | "poor";

/** cold = clear cache; warm = prior sitespeed run with shared Chrome profile, then measure */
export type CacheMode = "cold" | "warm";

export type SiteSpeedTestInput = {
  /** Separates product areas on one domain (Telegraf tag / S3 prefix) */
  metricPrefix: string;
  /** PotatoNetwork country profile at boot (e.g. "BD", "DE") */
  country: string;
  tier?: PotatoTier;
  /** Host used in the entry URL (e.g. example.com) */
  tld: string;
  tableId?: string;
  /** With tableId: enter-table when true (default true). Without tableId: always true for metrics. */
  direct?: boolean;
  browser?: string;
  /** Default: cold */
  cacheMode?: CacheMode;
  /**
   * Chrome DevTools CPUThrottlingRate (e.g. 4 = 4× slower).
   * Unset → no CPU throttling (network shaping via Potato only).
   */
  cpuThrottlingRate?: number;
};

export type NormalizedSiteSpeedTestInput = {
  metricPrefix: string;
  country: string;
  tier: PotatoTier;
  tld: string;
  tableId?: string;
  direct: boolean;
  browser: string;
  cacheMode: CacheMode;
  /** Present only when set on input (≥ 1). */
  cpuThrottlingRate?: number;
};

export type SiteSpeedTestResult = {
  url: string;
  msid: string;
  mode: "lobby" | "lobby-table" | "direct-table";
  metricPrefix: string;
  cacheMode: CacheMode;
  direct: boolean;
  /** Derived: workflow tld !== worker BASE_TLD */
  isMirror: boolean;
  /** S3 / Grafana prefix (dotted dimensions, no URL) */
  artifactNamespace: string;
  /** @deprecated alias of artifactNamespace */
  graphiteNamespace: string;
  potatoContainer: string;
  sitespeedExitCode: number;
};

export type PotatoRefreshResult = {
  potatoContainer: string;
  catalogOk: boolean;
  baselineProbedAt?: string;
  /** Images pulled at the start of refresh (POTATO_IMAGE, SITESPEED_IMAGE). */
  pulledImages: string[];
};

/**
 * Lightweight handle passed between sitespeed activities.
 * Heavy JSON lives on disk under `runRoot` (not in workflow history).
 */
export type SitespeedRunHandle = {
  /** Engine-host staging dir bind-mounted as /sitespeed.io */
  runRoot: string;
  /** sitespeed --outputFolder on host (= runRoot/results) */
  resultsRoot: string;
  artifactNamespace: string;
  slug: string;
  isMirror: boolean;
  browser: string;
  metricPrefix: string;
  country: string;
  tier: PotatoTier;
  tld: string;
  cacheMode: CacheMode;
  direct: boolean;
  url: string;
  potatoContainer: string;
  potatoApiBaseUrl: string;
  /** Chrome CPUThrottlingRate when set (integer ≥ 1). */
  cpuThrottlingRate?: number;
};
