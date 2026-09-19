import { isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import type { WorkerEnv } from "./env";

const resolver = new Resolver();

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

function s3Hostnames(env: WorkerEnv): string[] {
  const hosts: string[] = [];
  if (env.s3Endpoint) {
    const h = extractHostname(env.s3Endpoint);
    if (h) hosts.push(h);
  } else if (env.s3Bucket && env.s3Region) {
    hosts.push(`s3.${env.s3Region}.amazonaws.com`);
    hosts.push(`${env.s3Bucket}.s3.${env.s3Region}.amazonaws.com`);
  } else if (env.s3Bucket) {
    hosts.push("s3.amazonaws.com");
    hosts.push(`${env.s3Bucket}.s3.amazonaws.com`);
  }
  if (env.s3ResultBaseUrl) {
    const h = extractHostname(env.s3ResultBaseUrl);
    if (h) hosts.push(h);
  }
  return hosts;
}

function graphiteHostnames(env: WorkerEnv): string[] {
  if (!env.graphiteHost) return [];
  const h = extractHostname(env.graphiteHost);
  return h ? [h] : [];
}

async function resolveHostToIpv4(host: string): Promise<string[]> {
  if (host.includes("/")) {
    // Already a CIDR
    return [host];
  }
  if (isIP(host) === 4) {
    return [host];
  }
  if (isIP(host) === 6) {
    // PotatoNetwork SHAPE_EXCLUDE docs are IPv4/CIDR; skip v6
    return [];
  }
  try {
    const addrs = await resolver.resolve4(host);
    return addrs;
  } catch {
    try {
      // fallback: lookup may return A via system
      const { lookup } = await import("node:dns/promises");
      const r = await lookup(host, { family: 4, all: true });
      return r.map((x) => x.address);
    } catch {
      return [];
    }
  }
}

/**
 * Build POTATONETWORK_SHAPE_EXCLUDE: manual env entries plus resolved
 * IPv4 addresses for Graphite and S3 export endpoints.
 */
export async function buildShapeExclude(env: WorkerEnv): Promise<string> {
  const manual = (env.potatoShapeExclude ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const hostnames = [
    ...new Set([...graphiteHostnames(env), ...s3Hostnames(env)]),
  ];

  const resolved: string[] = [];
  for (const host of hostnames) {
    resolved.push(...(await resolveHostToIpv4(host)));
  }

  const all = [...new Set([...manual, ...resolved])];
  return all.join(",");
}
