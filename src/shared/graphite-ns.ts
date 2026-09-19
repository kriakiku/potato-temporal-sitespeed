/**
 * Build Graphite namespace: <base>.<metricPrefix>.<cacheMode>
 * Keeps product-area and cache-mode metrics separated on the same host.
 */
export function buildGraphiteNamespace(
  metricPrefix: string,
  cacheMode: string,
  base = "sitespeed",
): string {
  const cleanBase = base.replace(/\.+$/, "").trim() || "sitespeed";
  const cleanPrefix = metricPrefix.replace(/^\.+/, "").trim();
  const cleanCache = cacheMode.trim() || "cold";
  return `${cleanBase}.${cleanPrefix}.${cleanCache}`;
}

/** Sanitize metricPrefix + cacheMode for sitespeed --slug / S3 path segment. */
export function buildResultSlug(metricPrefix: string, cacheMode: string): string {
  const prefix = metricPrefix.replace(/[^a-zA-Z0-9._-]/g, "-");
  const cache = cacheMode.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${prefix}-${cache}`;
}
