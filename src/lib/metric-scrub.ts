/**
 * Scrub hosts/paths for Telegraf tags: strip query/hash, replace workflow tld
 * with the literal `{tld}` so session IDs and apex domains don't explode cardinality.
 */

export function stripQueryAndHash(path: string): string {
  let p = path.trim();
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p) return "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

/** Normalize apex like `Example.COM.` → `example.com`. */
export function normalizeApex(tld: string): string {
  return tld
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * Replace workflow apex (and its subdomains) with `{tld}`.
 * `api.example.com` + tld `example.com` → `api.{tld}`
 * `example.com` → `{tld}`
 */
export function scrubHostForMetrics(host: string, workflowTld: string): string {
  let h = host.trim().toLowerCase();
  // strip brackets / port
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end > 0) h = h.slice(1, end);
  } else {
    const colon = h.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) {
      h = h.slice(0, colon);
    }
  }
  h = h.replace(/\.$/, "");

  const apex = normalizeApex(workflowTld);
  if (!apex) return h;
  if (h === apex) return "{tld}";
  if (h.endsWith(`.${apex}`)) {
    return `${h.slice(0, h.length - apex.length)}{tld}`;
  }
  return h;
}

export function scrubPathForMetrics(path: string): string {
  return stripQueryAndHash(path);
}
