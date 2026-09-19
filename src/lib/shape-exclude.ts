import { isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import type { WorkerEnv } from "./env";
import { extractHostname } from "./hostname";
import { resolveHostForPotatoNetns } from "./host-gateway";

export { extractHostname };

const resolver = new Resolver();

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

function influxWriteHostnames(env: WorkerEnv): string[] {
  if (!env.influxWriteUrl) return [];
  const h = extractHostname(env.influxWriteUrl);
  return h ? [h] : [];
}

async function resolveHostToIpv4(host: string): Promise<string[]> {
  if (host.includes("/")) {
    return [host];
  }
  if (isIP(host) === 4) {
    return [host];
  }
  if (isIP(host) === 6) {
    return [];
  }
  try {
    const addrs = await resolver.resolve4(host);
    return addrs;
  } catch {
    try {
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
 * IPv4 addresses for Influx write URL and S3 endpoints.
 */
export async function buildShapeExclude(env: WorkerEnv): Promise<string> {
  const manual = (env.potatoShapeExclude ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const rawHosts = [
    ...new Set([...influxWriteHostnames(env), ...s3Hostnames(env)]),
  ];

  const hostnames: string[] = [];
  for (const host of rawHosts) {
    hostnames.push(await resolveHostForPotatoNetns(host));
  }

  const resolved: string[] = [];
  for (const host of [...new Set(hostnames)]) {
    resolved.push(...(await resolveHostToIpv4(host)));
  }

  const all = [...new Set([...manual, ...resolved])];
  return all.join(",");
}
