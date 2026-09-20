import { existsSync, statSync } from "node:fs";
import { heartbeat } from "@temporalio/activity";
import { getEnv } from "../lib/env";
import { podman } from "../lib/podman";
import { buildShapeExclude } from "../lib/shape-exclude";
import type { PotatoTier } from "../shared/types";

export type StartPotatoInput = {
  runId: string;
  /** When set, applies country profile at boot. Omit for passthrough (refresh). */
  country?: string;
  tier?: PotatoTier;
  namePrefix?: string;
};

export type EnsurePotatoInput = {
  country: string;
  tier?: PotatoTier;
};

export type PotatoHandle = {
  containerName: string;
  apiBaseUrl: string;
};

/** PotatoNetwork path-delay script inside the container (hot-reloaded on mtime). */
export const POTATO_RULES_EXPR_CONTAINER_PATH = "/data/rules.expr";

/** Long-lived per-location sidecars share this prefix (also matches ephemeral leftovers). */
export const POTATO_CONTAINER_PREFIX = "potato-";

function containerNameFor(runId: string, prefix = "potato"): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
  return `${prefix}-${safe || Date.now()}`;
}

/** Stable name for a country/tier profile container, e.g. potato-BD-typical. */
export function stablePotatoContainerName(
  country: string,
  tier: PotatoTier = "typical",
): string {
  const c = country.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "XX";
  const t = tier.replace(/[^a-zA-Z0-9]/g, "") || "typical";
  return `${POTATO_CONTAINER_PREFIX}${c}-${t}`;
}

function potatoBinds(dataVolume: string, rulesExprHostPath?: string): string[] {
  const binds = [`${dataVolume}:/data`];
  if (rulesExprHostPath) {
    binds.push(
      `${rulesExprHostPath}:${POTATO_RULES_EXPR_CONTAINER_PATH}:ro`,
    );
  }
  return binds;
}

/** Validate host path for POTATO_RULES_EXPR (interpreted by the engine host). */
export function assertPotatoRulesExpr(hostPath: string): void {
  if (!hostPath.startsWith("/")) {
    throw new Error(
      `POTATO_RULES_EXPR must be an absolute path on the Podman/Docker host (got: ${hostPath})`,
    );
  }
  if (!existsSync(hostPath)) {
    throw new Error(
      `POTATO_RULES_EXPR file not found on this host: ${hostPath}`,
    );
  }
  const st = statSync(hostPath);
  if (!st.isFile()) {
    throw new Error(`POTATO_RULES_EXPR must be a regular file: ${hostPath}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchHealth(apiBaseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBaseUrl}/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function apiFetch<T>(
  apiBaseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { potatoApiToken } = getEnv();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (potatoApiToken) {
    headers.Authorization = `Bearer ${potatoApiToken}`;
  }
  if (init?.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(120_000),
  });

  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `PotatoNetwork ${path} failed (${res.status}): ${text || res.statusText}`,
    );
  }

  return json as T;
}

async function buildPotatoContainerEnv(input: {
  country?: string;
  tier?: PotatoTier;
}): Promise<Record<string, string>> {
  const env = getEnv();
  const containerEnv: Record<string, string> = {
    POTATONETWORK_CATALOG_CRON: "false",
    POTATONETWORK_BASELINE_CRON: "false",
  };
  if (input.country) {
    containerEnv.POTATONETWORK_PROFILE_COUNTRY = input.country;
    containerEnv.POTATONETWORK_PROFILE_TIER = input.tier ?? "typical";
  }
  if (env.potatoApiToken) {
    containerEnv.POTATONETWORK_API_TOKEN = env.potatoApiToken;
  }

  const shapeExclude = await buildShapeExclude(env);
  if (shapeExclude) {
    containerEnv.POTATONETWORK_SHAPE_EXCLUDE = shapeExclude;
  }

  if (env.potatoRulesExpr) {
    assertPotatoRulesExpr(env.potatoRulesExpr);
  }

  return containerEnv;
}

async function handleFromRunningContainer(
  containerName: string,
): Promise<PotatoHandle> {
  const binding = await waitForPort(containerName, 7783);
  const host = binding.host === "0.0.0.0" ? "127.0.0.1" : binding.host;
  return {
    containerName,
    apiBaseUrl: `http://${host}:${binding.port}`,
  };
}

async function createPotatoContainer(opts: {
  containerName: string;
  country?: string;
  tier?: PotatoTier;
  forceReplace: boolean;
}): Promise<PotatoHandle> {
  const env = getEnv();
  const containerEnv = await buildPotatoContainerEnv({
    country: opts.country,
    tier: opts.tier,
  });

  await podman.runDetached({
    name: opts.containerName,
    image: env.potatoImage,
    capAdd: ["NET_ADMIN"],
    binds: potatoBinds(env.potatoDataVolume, env.potatoRulesExpr),
    publish: [{ containerPort: 7783, hostIp: "127.0.0.1" }],
    env: containerEnv,
    forceReplace: opts.forceReplace,
  });

  return handleFromRunningContainer(opts.containerName);
}

/** Ephemeral Potato (refresh / legacy). Always force-replaces the name. */
export async function startPotato(input: StartPotatoInput): Promise<PotatoHandle> {
  const containerName = containerNameFor(
    input.runId,
    input.namePrefix ?? "potato",
  );
  return createPotatoContainer({
    containerName,
    country: input.country,
    tier: input.tier,
    forceReplace: true,
  });
}

/**
 * Long-lived per-country Potato: reuse if healthy, otherwise create.
 * Does not tear down on success — callers must not stopPotato after measure.
 */
export async function ensurePotato(
  input: EnsurePotatoInput,
): Promise<PotatoHandle> {
  const tier = input.tier ?? "typical";
  const containerName = stablePotatoContainerName(input.country, tier);

  if (await podman.isContainerRunning(containerName)) {
    const handle = await handleFromRunningContainer(containerName);
    try {
      await waitPotatoHealthy(handle, 15_000);
      return handle;
    } catch {
      // Unhealthy — recreate below.
      await podman.stopContainer(containerName).catch(() => undefined);
      await podman.removeContainer(containerName, true).catch(() => undefined);
    }
  } else {
    // Stopped / missing — clear any leftover name before create.
    await podman.removeContainer(containerName, true).catch(() => undefined);
  }

  return createPotatoContainer({
    containerName,
    country: input.country,
    tier,
    forceReplace: true,
  });
}

async function waitForPort(
  container: string,
  containerPort: number,
  attempts = 30,
): Promise<{ host: string; port: number }> {
  for (let i = 0; i < attempts; i++) {
    heartbeat({ step: "wait-port", attempt: i });
    const binding = await podman.inspectPort(container, containerPort);
    if (binding) return binding;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for port ${containerPort} on ${container}`);
}

export async function waitPotatoHealthy(
  handle: PotatoHandle,
  timeoutMs = 60_000,
): Promise<void> {
  const env = getEnv();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    heartbeat({ step: "health", attempt: attempt++ });
    if (await fetchHealth(handle.apiBaseUrl)) {
      if (await fetchCaReady(handle.apiBaseUrl, env.potatoApiToken)) {
        return;
      }
    }
    await sleep(1000);
  }
  throw new Error(
    `PotatoNetwork ${handle.containerName} did not become healthy at ${handle.apiBaseUrl}`,
  );
}

async function fetchCaReady(
  apiBaseUrl: string,
  token?: string,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${apiBaseUrl}/v1/ca.pem`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const pem = await res.text();
    return pem.includes("BEGIN CERTIFICATE");
  } catch {
    return false;
  }
}

export async function stopPotato(handle: PotatoHandle): Promise<void> {
  await podman.stopContainer(handle.containerName);
  await podman.removeContainer(handle.containerName, true);
}

/**
 * Stop+rm every PotatoNetwork sidecar (long-lived country + ephemeral leftovers).
 * Used by potatoRefreshWorkflow to avoid memory leaks before catalog refresh.
 */
export async function stopAllPotatoContainers(): Promise<{ stopped: string[] }> {
  const names = await podman.listContainerNamesByPrefix(POTATO_CONTAINER_PREFIX);
  const stopped: string[] = [];
  for (const name of names) {
    await podman.stopContainer(name).catch(() => undefined);
    await podman.removeContainer(name, true).catch(() => undefined);
    stopped.push(name);
  }
  return { stopped };
}

export async function refreshPotatoCatalog(
  handle: PotatoHandle,
): Promise<{ ok: boolean; generatedAt?: string }> {
  return apiFetch(handle.apiBaseUrl, "/v1/catalog/refresh", { method: "POST" });
}

export async function refreshPotatoBaseline(
  handle: PotatoHandle,
): Promise<{ hostRtt?: Record<string, number>; probedAt?: string }> {
  return apiFetch(handle.apiBaseUrl, "/v1/baseline/probe", { method: "POST" });
}

export type PotatoProfile = {
  country?: string;
  tier?: string;
  delayMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  lossPercent?: number;
  passthrough?: boolean;
  emulationLimited?: boolean;
  warning?: string;
};

export type PotatoBaseline = {
  hostRtt?: Record<string, number>;
  probedAt?: string;
};

export type PotatoStatsDomain = {
  domain: string;
  count: number;
  errorCount: number;
  latencyMs: { sumMs: number; minMs: number; maxMs: number };
};

export type PotatoStatsRequest = {
  host: string;
  method?: string;
  path: string;
  count: number;
  started?: number;
  errorCount: number;
  latencyMs: { sumMs: number; minMs: number; maxMs: number };
};

export type PotatoStatsSnapshot = {
  dns: PotatoStatsDomain[];
  tlsClient: PotatoStatsDomain[];
  tlsUpstream: PotatoStatsDomain[];
  http?: PotatoStatsRequest[];
  websocket?: PotatoStatsRequest[];
  events?: PotatoStatsEvent[];
  /** Top-N longest HTTP start→response samples (not WS). */
  slowHTTP?: PotatoHTTPSample[];
  /** Cloudflare cf-cache-status → count; "NONE" = not Cloudflare. */
  cfCache?: Record<string, number>;
};

export type PotatoStatsEvent = {
  kind: string;
  host: string;
  method?: string;
  path: string;
  atUnixMs: number;
};

export type PotatoHTTPSample = {
  host: string;
  method: string;
  path: string;
  durationMs: number;
  failed: boolean;
  atUnixMs: number;
};

export type PotatoCatalogCountry = {
  id: string;
  nearestAws?: string;
  tiers?: Record<
    string,
    {
      downloadMbps?: number;
      uploadMbps?: number;
      lossPercent?: number;
      rttToDest?: Record<string, number>;
    }
  >;
};

export async function getPotatoProfile(
  apiBaseUrl: string,
): Promise<PotatoProfile> {
  return apiFetch(apiBaseUrl, "/v1/profile");
}

export async function getPotatoBaseline(
  apiBaseUrl: string,
): Promise<PotatoBaseline> {
  return apiFetch(apiBaseUrl, "/v1/baseline");
}

export async function getPotatoStats(
  apiBaseUrl: string,
): Promise<PotatoStatsSnapshot> {
  return apiFetch(apiBaseUrl, "/v1/stats");
}

/** Reset Potato counters (e.g. after warm-cache fill, before measure). */
export async function resetPotatoStats(
  handle: Pick<PotatoHandle, "apiBaseUrl">,
): Promise<void> {
  await apiFetch(handle.apiBaseUrl, "/v1/stats/reset", { method: "POST" });
}

export async function getPotatoCatalogCountry(
  apiBaseUrl: string,
  countryId: string,
): Promise<PotatoCatalogCountry | undefined> {
  const cat = await apiFetch<{ countries?: PotatoCatalogCountry[] }>(
    apiBaseUrl,
    "/v1/catalog",
  );
  const id = countryId.toUpperCase();
  return (cat.countries ?? []).find((c) => c.id?.toUpperCase() === id);
}

