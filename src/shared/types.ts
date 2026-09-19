/** Shared types safe for Temporal workflows (deterministic, no I/O). */

export type PotatoTier = "stable" | "typical" | "poor";

/** cold = fresh profile each iteration; warm = preURL warms cache then measure */
export type CacheMode = "cold" | "warm";

export type SiteSpeedTestInput = {
  /** Graphite/S3 metric prefix — separates product areas on one domain */
  metricPrefix: string;
  /** PotatoNetwork country profile at boot (e.g. "BD", "DE") */
  country: string;
  tier?: PotatoTier;
  /** Host used in the entry URL (e.g. example.com) */
  tld: string;
  tableId?: string;
  /** Only meaningful with tableId; default false when tableId set, true for lobby metrics */
  direct?: boolean;
  browser?: string;
  iterations?: number;
  /** Default: cold */
  cacheMode?: CacheMode;
};

export type NormalizedSiteSpeedTestInput = {
  metricPrefix: string;
  country: string;
  tier: PotatoTier;
  tld: string;
  tableId?: string;
  direct: boolean;
  browser: string;
  iterations: number;
  cacheMode: CacheMode;
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
  graphiteNamespace: string;
  potatoContainer: string;
  sitespeedExitCode: number;
};

export type PotatoRefreshResult = {
  potatoContainer: string;
  catalogOk: boolean;
  baselineProbedAt?: string;
};
