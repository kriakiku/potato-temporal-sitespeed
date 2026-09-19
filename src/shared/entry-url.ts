import type {
  NormalizedSiteSpeedTestInput,
  PotatoTier,
  SiteSpeedTestInput,
} from "./types";

const DEFAULT_TLD = "winfinity.live";
const DEFAULT_TIER: PotatoTier = "typical";
const DEFAULT_BROWSER = "chrome";
const DEFAULT_ITERATIONS = 3;

/**
 * Build the sitespeed entry URL from Temporal workflow input.
 *
 * - No tableId → https://{tld}/
 * - With tableId → https://{tld}/?tableId={id}&direct={true|false}
 *   (direct defaults to false when tableId is set)
 */
export function buildEntryUrl(input: {
  tld: string;
  tableId?: string;
  direct: boolean;
}): string {
  const base = `https://${input.tld}/`;
  if (!input.tableId) {
    return base;
  }
  const params = new URLSearchParams({
    tableId: input.tableId,
    direct: input.direct ? "true" : "false",
  });
  return `${base}?${params.toString()}`;
}

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

  return {
    metricPrefix,
    country,
    tier: input.tier ?? DEFAULT_TIER,
    tld,
    tableId,
    direct,
    browser: input.browser?.trim() || DEFAULT_BROWSER,
    iterations: input.iterations && input.iterations > 0
      ? input.iterations
      : DEFAULT_ITERATIONS,
  };
}
