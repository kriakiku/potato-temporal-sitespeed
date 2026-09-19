/**
 * Sitespeed/Potato share a container netns. Loopback there is NOT the engine
 * host — rewrite 127.0.0.1/localhost to a host gateway address.
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { getEnv } from "./env";
import { extractHostname } from "./hostname";
import { podman } from "./podman";

const LOOPBACK_NAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

let cachedGateway: string | undefined | null;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (LOOPBACK_NAMES.has(h)) return true;
  if (isIP(h) === 4 && h.startsWith("127.")) return true;
  return false;
}

async function resolveNameToIpv4(name: string): Promise<string | undefined> {
  try {
    const r = await lookup(name, { family: 4 });
    return r.address;
  } catch {
    return undefined;
  }
}

/**
 * Discover an IPv4 address of the engine host as seen from container networks.
 */
export async function resolveHostGateway(): Promise<string> {
  if (cachedGateway) return cachedGateway;
  if (cachedGateway === null) {
    throw new Error(
      "HOST_GATEWAY could not be resolved earlier; set HOST_GATEWAY to the host IP reachable from Podman/Docker containers",
    );
  }

  const env = getEnv();
  if (env.hostGateway) {
    const h = extractHostname(env.hostGateway) ?? env.hostGateway.trim();
    if (isIP(h) === 4) {
      cachedGateway = h;
      return h;
    }
    const resolved = await resolveNameToIpv4(h);
    if (resolved) {
      cachedGateway = resolved;
      return resolved;
    }
    throw new Error(
      `HOST_GATEWAY=${env.hostGateway} could not be resolved to an IPv4 address`,
    );
  }

  for (const name of ["host.containers.internal", "host.docker.internal"]) {
    const ip = await resolveNameToIpv4(name);
    if (ip && !isLoopbackHost(ip)) {
      cachedGateway = ip;
      return ip;
    }
  }

  const fromEngine = await podman.defaultNetworkGateway();
  if (fromEngine && !isLoopbackHost(fromEngine)) {
    cachedGateway = fromEngine;
    return fromEngine;
  }

  cachedGateway = null;
  throw new Error(
    "Could not determine host gateway for potato/sitespeed netns. Set HOST_GATEWAY to the host IPv4 reachable from containers (e.g. Podman bridge gateway).",
  );
}

/**
 * If `host` is loopback, return the engine-host gateway IP; otherwise return host unchanged.
 */
export async function resolveHostForPotatoNetns(host: string): Promise<string> {
  const trimmed = host.trim();
  if (!trimmed) return trimmed;
  const hostname = extractHostname(trimmed) ?? trimmed;
  if (!isLoopbackHost(hostname)) {
    return trimmed;
  }
  return resolveHostGateway();
}

/** Rewrite hostname inside a URL or host:port if it is loopback. */
export async function resolveEndpointForPotatoNetns(
  endpoint: string,
): Promise<string> {
  const value = endpoint.trim();
  if (!value) return value;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    try {
      const u = new URL(value);
      if (!isLoopbackHost(u.hostname)) return value;
      u.hostname = await resolveHostGateway();
      const out = u.toString();
      if (!value.endsWith("/") && out.endsWith("/") && u.pathname === "/") {
        return out.slice(0, -1);
      }
      return out;
    } catch {
      return value;
    }
  }

  const hostPort = value.match(/^([^:]+):(\d+)$/);
  if (hostPort && isLoopbackHost(hostPort[1])) {
    return `${await resolveHostGateway()}:${hostPort[2]}`;
  }

  if (isLoopbackHost(value)) {
    return resolveHostGateway();
  }

  return value;
}

/** Test helper — clear cached gateway between tests if any. */
export function resetHostGatewayCache(): void {
  cachedGateway = undefined;
}
