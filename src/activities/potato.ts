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

export type PotatoHandle = {
  containerName: string;
  apiBaseUrl: string;
};

function containerNameFor(runId: string, prefix = "potato"): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
  return `${prefix}-${safe || Date.now()}`;
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

export async function startPotato(input: StartPotatoInput): Promise<PotatoHandle> {
  const env = getEnv();
  const containerName = containerNameFor(input.runId, input.namePrefix ?? "potato");

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

  await podman.runDetached({
    name: containerName,
    image: env.potatoImage,
    capAdd: ["NET_ADMIN"],
    binds: [`${env.potatoDataVolume}:/data`],
    publish: [{ containerPort: 7783, hostIp: "127.0.0.1" }],
    env: containerEnv,
  });

  const binding = await waitForPort(containerName, 7783);
  const host = binding.host === "0.0.0.0" ? "127.0.0.1" : binding.host;
  return {
    containerName,
    apiBaseUrl: `http://${host}:${binding.port}`,
  };
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
