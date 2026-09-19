import { isIP } from "node:net";

/** Extract hostname from host, host:port, or URL. */
export function extractHostname(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    try {
      return new URL(value).hostname || undefined;
    } catch {
      return undefined;
    }
  }

  // host:port (IPv4 or name) — not IPv6 with brackets for simplicity
  if (value.includes("/") && !value.includes("://")) {
    // bare CIDR already — keep as-is via caller
    return value;
  }

  const hostPort = value.match(/^([^:]+):(\d+)$/);
  if (hostPort && !isIP(value)) {
    return hostPort[1];
  }

  return value;
}
