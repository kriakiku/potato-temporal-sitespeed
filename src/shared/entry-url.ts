import type {
  CacheMode,
  NormalizedSiteSpeedTestInput,
  PotatoTier,
  SiteSpeedTestInput,
} from "./types";

const DEFAULT_TIER: PotatoTier = "typical";
const DEFAULT_BROWSER = "chrome";
const DEFAULT_ITERATIONS = 3;
const DEFAULT_CACHE_MODE: CacheMode = "cold";

export function normalizeSiteSpeedInput(
  input: SiteSpeedTestInput,
): NormalizedSiteSpeedTestInput {
  const metricPrefix = input.metricPrefix?.trim();
  if (!metricPrefix) {
    throw new Error("metricPrefix is required");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(metricPrefix)) {
    throw new Error(
      `metricPrefix must be alphanumeric with ._- (got: ${metricPrefix})`,
    );
  }

  const country = input.country?.trim();
  if (!country) {
    throw new Error("country is required");
  }

  const tldRaw = input.tld?.trim();
  if (!tldRaw) {
    throw new Error("tld is required");
  }
  const tld = tldRaw.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const tableId = input.tableId?.trim() || undefined;
  // No tableId → always true (lobby metrics). With tableId → input.direct, default true.
  const direct = tableId ? (input.direct ?? true) : true;

  const cacheMode = input.cacheMode ?? DEFAULT_CACHE_MODE;
  if (cacheMode !== "cold" && cacheMode !== "warm") {
    throw new Error(`cacheMode must be cold|warm (got: ${cacheMode})`);
  }

  return {
    metricPrefix,
    country,
    tier: input.tier ?? DEFAULT_TIER,
    tld,
    tableId,
    direct,
    browser: input.browser?.trim() || DEFAULT_BROWSER,
    iterations:
      input.iterations && input.iterations > 0
        ? input.iterations
        : DEFAULT_ITERATIONS,
    cacheMode,
  };
}
