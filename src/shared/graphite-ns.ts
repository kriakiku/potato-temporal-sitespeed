/**
 * Build Graphite namespace: <base>.<metricPrefix>
 * Keeps product-area metrics separated even when the page host is the same.
 */
export function buildGraphiteNamespace(
  metricPrefix: string,
  base = "sitespeed",
): string {
  const cleanBase = base.replace(/\.+$/, "").trim() || "sitespeed";
  const cleanPrefix = metricPrefix.replace(/^\.+/, "").trim();
  return `${cleanBase}.${cleanPrefix}`;
}

/** Sanitize metricPrefix for use as sitespeed --slug / S3 path segment. */
export function buildResultSlug(metricPrefix: string): string {
  return metricPrefix.replace(/[^a-zA-Z0-9._-]/g, "-");
}
