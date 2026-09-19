import type {
  NormalizedSiteSpeedTestInput,
  PotatoTier,
  SiteSpeedTestInput,
} from "./types";

const DEFAULT_TLD = "winfinity.live";
const DEFAULT_TIER: PotatoTier = "typical";
const DEFAULT_BROWSER = "chrome";
const DEFAULT_ITERATIONS = 3;

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

  const tld = (input.tld?.trim() || DEFAULT_TLD).replace(/^https?:\/\//, "");
  const tableId = input.tableId?.trim() || undefined;
  const direct = tableId ? (input.direct ?? false) : false;

  if (direct && !tableId) {
    throw new Error("direct=true requires tableId");
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
  };
}
