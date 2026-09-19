/** Shared types safe for Temporal workflows (deterministic, no I/O). */

export type PotatoTier = "stable" | "typical" | "poor";

export type SiteSpeedTestInput = {
  /** Graphite/S3 metric prefix — separates product areas on one domain */
  metricPrefix: string;
  /** PotatoNetwork country profile at boot (e.g. "BD", "DE") */
  country: string;
  tier?: PotatoTier;
  /** Default: winfinity.live */
  tld?: string;
  tableId?: string;
  /** Only when tableId is set; default false */
  direct?: boolean;
  browser?: string;
  iterations?: number;
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
};

export type SiteSpeedTestResult = {
  url: string;
  metricPrefix: string;
  graphiteNamespace: string;
  potatoContainer: string;
  sitespeedExitCode: number;
};

export type PotatoRefreshResult = {
  potatoContainer: string;
  catalogOk: boolean;
  baselineProbedAt?: string;
};
