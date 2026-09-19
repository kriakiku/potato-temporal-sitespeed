/** Dimensions folded into Graphite namespace and S3/sitespeed slug. */
export type MetricDimensions = {
  metricPrefix: string;
  country: string;
  tier: string;
  cacheMode: string;
  /** Workflow `direct` (lobby without tableId defaults to true for metrics). */
  direct: boolean;
  isMirror: boolean;
  base?: string;
};

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "").trim();
  return cleaned || fallback;
}

/**
 * Graphite namespace:
 * `{base}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}`
 */
export function buildGraphiteNamespace(dims: MetricDimensions): string {
  const cleanBase = (dims.base ?? "sitespeed").replace(/\.+$/, "").trim() || "sitespeed";
  const prefix = sanitizeSegment(dims.metricPrefix, "run");
  const country = sanitizeSegment(dims.country, "XX");
  const tier = sanitizeSegment(dims.tier, "typical");
  const cache = sanitizeSegment(dims.cacheMode, "cold");
  const direct = dims.direct ? "true" : "false";
  const mirror = dims.isMirror ? "true" : "false";
  return `${cleanBase}.${prefix}.${country}.${tier}.${cache}.${direct}.${mirror}`;
}

/**
 * sitespeed --slug / S3 path segment:
 * `{metricPrefix}-{country}-{tier}-{cacheMode}-{direct}-{isMirror}`
 */
export function buildResultSlug(dims: Omit<MetricDimensions, "base">): string {
  const prefix = sanitizeSegment(dims.metricPrefix, "run");
  const country = sanitizeSegment(dims.country, "XX");
  const tier = sanitizeSegment(dims.tier, "typical");
  const cache = sanitizeSegment(dims.cacheMode, "cold");
  const direct = dims.direct ? "true" : "false";
  const mirror = dims.isMirror ? "true" : "false";
  return `${prefix}-${country}-${tier}-${cache}-${direct}-${mirror}`;
}

/** True when workflow tld differs from worker BASE_TLD (unset BASE_TLD → false). */
export function resolveIsMirror(
  tld: string,
  baseTld: string | undefined,
): boolean {
  if (!baseTld) return false;
  const a = tld
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const b = baseTld
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return a !== b;
}
