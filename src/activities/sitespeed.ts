import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CancelledFailure,
  Context,
  heartbeat,
  log,
} from "@temporalio/activity";
import {
  getPotatoBaseline,
  getPotatoCatalogCountry,
  getPotatoProfile,
  getPotatoStats,
  type PotatoBaseline,
  type PotatoProfile,
  type PotatoStatsDomain,
  type PotatoStatsRequest,
  type PotatoStatsSnapshot,
} from "./potato";
import {
  aggregateFieldMaps,
  medianSampleIndex,
} from "../lib/aggregate-stats";
import { assertExportConfig, getEnv } from "../lib/env";
import { buildMeasureJourneyScript } from "../lib/bt-measure-journey";
import { buildInfluxPoints, type OverlayInfluxMeta } from "../lib/influx-points";
import {
  buildOverlayTimeline,
  lastN,
  OVERLAY_SLOT_LIMIT,
  type OverlayTimeline,
} from "../lib/overlay-timeline";
import {
  burnOverlayOntoVideo,
  overlayWorkDirFor,
} from "../lib/overlay-ffmpeg";
import { emitInfluxWrite } from "../lib/influx";
import { PodmanCancelledError, podman } from "../lib/podman";
import { uploadLocalSitespeedArtifacts } from "../lib/s3-latest";
import {
  emptySitespeedMetricsBundle,
  findLocalAsset,
  loadSitespeedMetrics,
  type SitespeedMetricsBundle,
  type SitespeedTimingFields,
  type TaggedMetricPoint,
} from "../lib/sitespeed-json";
import {
  measureResultsContainerPath,
  measureResultsHostPath,
  potatoCpuMetricsPath,
  potatoEnrichmentPath,
  potatoEnrichmentRunPath,
  potatoMetricsPath,
  potatoMetricsRunPath,
  potatoOverlayResultPath,
} from "../lib/sitespeed-run-paths";
import {
  buildArtifactNamespace,
  buildResultSlug,
  metricTagsFromDims,
  resolveIsMirror,
} from "../shared/graphite-ns";
import {
  buildSitespeedBrowserArgs,
  CHROME_DEVICE_NAME,
  CONTAINER_CHROME_PROFILE,
  MEASURE_RUNS,
} from "../shared/sitespeed-args";
import { sitespeedPotatoEntrypoint } from "../shared/sitespeed-entrypoint";
import type {
  CacheMode,
  PotatoTier,
  SitespeedRunHandle,
} from "../shared/types";

export { CHROME_DEVICE_NAME } from "../shared/sitespeed-args";
export { buildInfluxPoints } from "../lib/influx-points";
export { MEASURE_RUNS } from "../shared/sitespeed-args";

const CONTAINER_FIRST_IFRAME_SCRIPT = "/sitespeed.io/bt-first-iframe.js";
const CONTAINER_MEASURE_JOURNEY = "/sitespeed.io/bt-measure-journey.js";
const HOST_FIRST_IFRAME_SCRIPT = fileURLToPath(
  new URL("../../scripts/bt-first-iframe.js", import.meta.url),
);

export type PrepareSitespeedRunInput = {
  potatoContainer: string;
  potatoApiBaseUrl: string;
  url: string;
  metricPrefix: string;
  country: string;
  tier: PotatoTier;
  tld: string;
  browser: string;
  cacheMode: CacheMode;
  direct: boolean;
  cpuThrottlingRate?: number;
};

type PotatoEnrichmentDisk = {
  profile: PotatoProfile;
  baseline: PotatoBaseline;
  stats: PotatoStatsSnapshot;
  catalogCfRtt?: number;
  catalogNearestAwsRtt?: number;
  nearestAws?: string;
  overlayTimeline: OverlayTimeline;
  overlayMeta: OverlayInfluxMeta;
};

type PotatoOverlayResultDisk = {
  burned: boolean;
  potatoMp4?: string;
};

function tail(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return text.slice(-max);
}

/** Temporal rejects oversized activity failures; keep messages small. */
const FAILURE_MESSAGE_MAX = 1500;

/**
 * Compact stderr/stdout into a Temporal-safe failure message.
 * Prefer UrlLoadError / ERROR lines; drop huge JSON blobs (Lighthouse payloads).
 */
export function summarizeSitespeedFailure(
  exitCode: number,
  combined: string,
): string {
  const lines = combined.split(/\r?\n/);
  const picked: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /UrlLoadError/i.test(trimmed) ||
      /\] ERROR:/.test(trimmed) ||
      /chrome-error:\/\//i.test(trimmed) ||
      /is the web page down/i.test(trimmed) ||
      /Failed to load /i.test(trimmed)
    ) {
      if (trimmed === "{" || trimmed.startsWith('"uuid"')) continue;
      picked.push(trimmed.slice(0, 400));
      if (picked.length >= 12) break;
    }
  }

  const body =
    picked.length > 0
      ? picked.join("\n")
      : tail(combined.replace(/\s+/g, " ").trim(), 800);

  const msg = `sitespeed.io exited with code ${exitCode}\n${body}`;
  if (msg.length <= FAILURE_MESSAGE_MAX) return msg;
  return `${msg.slice(0, FAILURE_MESSAGE_MAX - 1)}…`;
}

function activityCancelSignal(): AbortSignal {
  return Context.current().cancellationSignal;
}

function rethrowIfCancelled(err: unknown): never {
  if (err instanceof CancelledFailure) throw err;
  if (err instanceof PodmanCancelledError) {
    throw new CancelledFailure(err.message);
  }
  if (Context.current().cancellationSignal.aborted) {
    throw new CancelledFailure(
      err instanceof Error ? err.message : "activity cancelled",
    );
  }
  throw err;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

function isCpuFieldKey(key: string): boolean {
  return (
    key === "cpuBenchmark" ||
    key.startsWith("jsHeap") ||
    key.startsWith("cpu_")
  );
}

export function filterCpuMetrics(
  bundle: SitespeedMetricsBundle,
): SitespeedMetricsBundle {
  const browsertime: SitespeedTimingFields = {};
  for (const [k, v] of Object.entries(bundle.browsertime)) {
    if (isCpuFieldKey(k)) browsertime[k] = v;
  }
  const browsertimeTagged = bundle.browsertimeTagged.filter(
    (p) => typeof p.tags.cpuCategory === "string",
  );
  return {
    ...emptySitespeedMetricsBundle(),
    browsertime,
    browsertimeTagged,
  };
}

/** Strip CPU fields from the main aggregate so the CPU-pass owns them. */
export function stripCpuFromBundle(
  bundle: SitespeedMetricsBundle,
): SitespeedMetricsBundle {
  const browsertime: SitespeedTimingFields = {};
  for (const [k, v] of Object.entries(bundle.browsertime)) {
    if (!isCpuFieldKey(k)) browsertime[k] = v;
  }
  const browsertimeTagged = bundle.browsertimeTagged.filter(
    (p) => typeof p.tags.cpuCategory !== "string",
  );
  return { ...bundle, browsertime, browsertimeTagged };
}

function aggregateTaggedPoints(
  runs: TaggedMetricPoint[][],
): TaggedMetricPoint[] {
  const byKey = new Map<string, { tags: Record<string, string>; maps: SitespeedTimingFields[] }>();
  for (const run of runs) {
    for (const p of run) {
      const key = JSON.stringify(
        Object.keys(p.tags)
          .sort()
          .map((k) => [k, p.tags[k]]),
      );
      let slot = byKey.get(key);
      if (!slot) {
        slot = { tags: { ...p.tags }, maps: [] };
        byKey.set(key, slot);
      }
      slot.maps.push({ ...p.fields });
    }
  }
  const out: TaggedMetricPoint[] = [];
  for (const slot of byKey.values()) {
    out.push({ tags: slot.tags, fields: aggregateFieldMaps(slot.maps) });
  }
  return out;
}

function aggregateMetricsBundles(
  bundles: SitespeedMetricsBundle[],
): SitespeedMetricsBundle {
  return {
    browsertime: aggregateFieldMaps(bundles.map((b) => b.browsertime)),
    browsertimeTagged: aggregateTaggedPoints(
      bundles.map((b) => b.browsertimeTagged),
    ),
    pagexray: aggregateFieldMaps(bundles.map((b) => b.pagexray)),
    pagexrayTagged: aggregateTaggedPoints(bundles.map((b) => b.pagexrayTagged)),
    coach: aggregateFieldMaps(bundles.map((b) => b.coach)),
    axe: aggregateFieldMaps(bundles.map((b) => b.axe)),
    lighthouse: aggregateFieldMaps(bundles.map((b) => b.lighthouse)),
    sustainable: aggregateFieldMaps(bundles.map((b) => b.sustainable)),
    thirdparty: aggregateFieldMaps(bundles.map((b) => b.thirdparty)),
    thirdpartyTagged: aggregateTaggedPoints(
      bundles.map((b) => b.thirdpartyTagged),
    ),
  };
}

function domainKey(d: PotatoStatsDomain): string {
  return d.domain;
}

function requestKey(r: PotatoStatsRequest): string {
  return `${r.host}\0${(r.method ?? "").toUpperCase()}\0${r.path}`;
}

function aggregateDomains(
  runs: PotatoStatsDomain[][],
): PotatoStatsDomain[] {
  const keys = new Set<string>();
  for (const run of runs) for (const d of run) keys.add(domainKey(d));
  const out: PotatoStatsDomain[] = [];
  for (const key of keys) {
    const samples = runs
      .map((run) => run.find((d) => domainKey(d) === key))
      .filter((d): d is PotatoStatsDomain => Boolean(d));
    if (!samples.length) continue;
    const countStats = aggregateFieldMaps(
      samples.map((d) => ({ count: d.count, errorCount: d.errorCount })),
    );
    const latStats = aggregateFieldMaps(
      samples.map((d) => ({
        sumMs: d.latencyMs.sumMs,
        minMs: d.latencyMs.minMs,
        maxMs: d.latencyMs.maxMs,
      })),
    );
    out.push({
      domain: samples[0]!.domain,
      count: countStats.count ?? 0,
      errorCount: countStats.errorCount ?? 0,
      latencyMs: {
        sumMs: latStats.sumMs ?? 0,
        minMs: latStats.minMs ?? 0,
        maxMs: latStats.maxMs ?? 0,
      },
    });
  }
  return out;
}

function aggregateRequests(
  runs: PotatoStatsRequest[][],
): PotatoStatsRequest[] {
  const keys = new Set<string>();
  for (const run of runs) for (const r of run) keys.add(requestKey(r));
  const out: PotatoStatsRequest[] = [];
  for (const key of keys) {
    const samples = runs
      .map((run) => run.find((r) => requestKey(r) === key))
      .filter((r): r is PotatoStatsRequest => Boolean(r));
    if (!samples.length) continue;
    const flat = aggregateFieldMaps(
      samples.map((r) => ({
        count: r.count,
        started: r.started ?? 0,
        errorCount: r.errorCount,
        sumMs: r.latencyMs.sumMs,
        minMs: r.latencyMs.minMs,
        maxMs: r.latencyMs.maxMs,
      })),
    );
    out.push({
      host: samples[0]!.host,
      method: samples[0]!.method,
      path: samples[0]!.path,
      count: flat.count ?? 0,
      started: flat.started,
      errorCount: flat.errorCount ?? 0,
      latencyMs: {
        sumMs: flat.sumMs ?? 0,
        minMs: flat.minMs ?? 0,
        maxMs: flat.maxMs ?? 0,
      },
    });
  }
  return out;
}

function aggregatePotatoStats(runs: PotatoStatsSnapshot[]): PotatoStatsSnapshot {
  const cfKeys = new Set<string>();
  for (const r of runs) {
    for (const k of Object.keys(r.cfCache ?? {})) cfKeys.add(k);
  }
  const cfCache: Record<string, number> = {};
  for (const status of cfKeys) {
    const samples = runs
      .map((r) => r.cfCache?.[status])
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const agg = aggregateFieldMaps(samples.map((count) => ({ count })));
    if (agg.count !== undefined) cfCache[status] = agg.count;
  }

  // slowHTTP / events: take from median-enrichment caller (not averaged)
  return {
    dns: aggregateDomains(runs.map((r) => r.dns ?? [])),
    tlsClient: aggregateDomains(runs.map((r) => r.tlsClient ?? [])),
    tlsUpstream: aggregateDomains(runs.map((r) => r.tlsUpstream ?? [])),
    http: aggregateRequests(runs.map((r) => r.http ?? [])),
    websocket: aggregateRequests(runs.map((r) => r.websocket ?? [])),
    cfCache: Object.keys(cfCache).length ? cfCache : undefined,
  };
}

type SitespeedPhase = "warmup" | "measure" | "cpu";

async function runSitespeedContainer(opts: {
  handle: SitespeedRunHandle;
  phase: SitespeedPhase;
  outputFolder: string;
  video: boolean;
  removeLighthouse: boolean;
  clearCache: boolean;
  chromeUserDataDir?: string;
  enableCpu?: boolean;
  enableAxe?: boolean;
  /** When false, run on default bridge without Potato MITM (slim warmup). */
  attachPotatoNetwork?: boolean;
  pageCompleteCheckMs?: number;
  pageLoadMs?: number;
  elementWaitMs?: number;
  runIndex?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = getEnv();
  const { handle } = opts;
  const attachPotato = opts.attachPotatoNetwork !== false;

  const slugSuffix =
    opts.phase === "warmup"
      ? `${handle.slug}-warmup`
      : opts.phase === "cpu"
        ? `${handle.slug}-cpu`
        : opts.runIndex !== undefined
          ? `${handle.slug}-r${opts.runIndex}`
          : handle.slug;

  const cmd = buildSitespeedBrowserArgs({
    browser: handle.browser,
    slug: slugSuffix,
    metricPrefix: handle.metricPrefix,
    cacheMode: handle.cacheMode,
    url: handle.url,
    outputFolder: opts.outputFolder,
    scriptPath: CONTAINER_FIRST_IFRAME_SCRIPT,
    multiScriptPath: CONTAINER_MEASURE_JOURNEY,
    removeLighthouse: opts.removeLighthouse,
    removeGpsi: true,
    cpuThrottlingRate: handle.cpuThrottlingRate,
    chromeUserDataDir: opts.chromeUserDataDir,
    video: opts.video,
    clearCache: opts.clearCache,
    firstPartyTld: handle.tld,
    enableCpu: opts.enableCpu === true,
    enableAxe: opts.enableAxe === true,
    pageCompleteCheckMs: opts.pageCompleteCheckMs,
    pageLoadMs: opts.pageLoadMs,
    elementWaitMs: opts.elementWaitMs,
  });

  const containerName = `sitespeed-${handle.slug}-${opts.phase}${
    opts.runIndex !== undefined ? `-r${opts.runIndex}` : ""
  }-${Date.now()}`;
  log.info("Starting sitespeed.io", {
    phase: opts.phase,
    runIndex: opts.runIndex ?? null,
    attachPotatoNetwork: attachPotato,
    enableCpu: opts.enableCpu === true,
    potatoContainer: handle.potatoContainer,
    url: handle.url,
    artifactNamespace: handle.artifactNamespace,
    slug: handle.slug,
    runRoot: handle.runRoot,
    cacheMode: handle.cacheMode,
    cpuThrottlingRate: handle.cpuThrottlingRate ?? null,
    chromeUserDataDir: opts.chromeUserDataDir ?? null,
    country: handle.country,
    tier: handle.tier,
    isMirror: handle.isMirror,
    tld: handle.tld,
    direct: handle.direct,
    deviceName: CHROME_DEVICE_NAME,
  });

  heartbeat({ step: `sitespeed-${opts.phase}` });
  const signal = activityCancelSignal();

  const binds = [`${handle.runRoot}:/sitespeed.io`];
  let entrypoint: string[] | undefined;
  let wrappedCmd = cmd;
  const containerEnv: Record<string, string> = {};

  if (attachPotato) {
    binds.unshift(`${env.potatoDataVolume}:/potato-data:ro`);
    containerEnv.NODE_EXTRA_CA_CERTS =
      "/potato-data/ca/potatonetwork-ca.pem";
    const wrapped = sitespeedPotatoEntrypoint(cmd);
    entrypoint = wrapped.entrypoint;
    wrappedCmd = wrapped.cmd;
  }

  try {
    return await podman.runToCompletion(
      {
        name: containerName,
        image: env.sitespeedImage,
        entrypoint,
        cmd: wrappedCmd,
        networkMode: attachPotato
          ? `container:${handle.potatoContainer}`
          : undefined,
        binds,
        env: Object.keys(containerEnv).length ? containerEnv : undefined,
        shmSizeBytes: 2 * 1024 * 1024 * 1024,
      },
      () => heartbeat({ step: `sitespeed-${opts.phase}-running` }),
      signal,
    );
  } catch (err) {
    rethrowIfCancelled(err);
  }
}

export async function prepareSitespeedRun(
  input: PrepareSitespeedRunInput,
): Promise<SitespeedRunHandle> {
  const env = getEnv();
  assertExportConfig(env);

  const isMirror = resolveIsMirror(input.tld, env.baseTld);
  const dims = {
    metricPrefix: input.metricPrefix,
    country: input.country,
    tier: input.tier,
    cacheMode: input.cacheMode,
    direct: input.direct,
    isMirror,
    base: env.artifactNamespaceBase,
  };
  const artifactNamespace = buildArtifactNamespace(dims);
  const slug = buildResultSlug(dims);

  const runRoot = join(env.sitespeedResultsDir, `${slug}-${Date.now()}`);
  await mkdir(runRoot, { recursive: true });
  if (input.cacheMode === "warm") {
    await mkdir(join(runRoot, "chrome-profile"), { recursive: true });
  }

  try {
    await copyFile(
      HOST_FIRST_IFRAME_SCRIPT,
      join(runRoot, "bt-first-iframe.js"),
    );
    await writeFile(
      join(runRoot, "bt-measure-journey.js"),
      buildMeasureJourneyScript({
        url: input.url,
        alias: input.metricPrefix,
      }),
      "utf8",
    );
  } catch (err) {
    throw new Error(
      `Failed to stage browsertime scripts into ${runRoot}: ${
        err instanceof Error ? err.message : String(err)
      } (src=${HOST_FIRST_IFRAME_SCRIPT})`,
    );
  }

  return {
    runRoot,
    // Point at results-1 until aggregateMeasureRuns selects the median run.
    resultsRoot: measureResultsHostPath(runRoot, 1),
    artifactNamespace,
    slug,
    isMirror,
    browser: input.browser,
    metricPrefix: input.metricPrefix,
    country: input.country,
    tier: input.tier,
    tld: input.tld,
    cacheMode: input.cacheMode,
    direct: input.direct,
    url: input.url,
    potatoContainer: input.potatoContainer,
    potatoApiBaseUrl: input.potatoApiBaseUrl,
    cpuThrottlingRate: input.cpuThrottlingRate,
  };
}

/**
 * Slim cache fill: no Potato network, no video/CPU/axe/Lighthouse.
 * Non-zero exit is logged but does not throw (partial profile is ok).
 */
export async function warmupSitespeedCache(
  handle: SitespeedRunHandle,
): Promise<{ ok: boolean; exitCode: number }> {
  try {
    const warmup = await runSitespeedContainer({
      handle,
      phase: "warmup",
      outputFolder: "/sitespeed.io/warmup-results",
      video: false,
      removeLighthouse: true,
      clearCache: false,
      chromeUserDataDir: CONTAINER_CHROME_PROFILE,
      enableCpu: false,
      enableAxe: false,
      attachPotatoNetwork: false,
      pageCompleteCheckMs: 60_000,
      pageLoadMs: 90_000,
      elementWaitMs: 30_000,
    });
    if (warmup.exitCode !== 0) {
      log.warn("warmupSitespeedCache non-zero exit (continuing)", {
        exitCode: warmup.exitCode,
        stderrTail: tail(warmup.stderr, 800),
      });
      return { ok: false, exitCode: warmup.exitCode };
    }
    return { ok: true, exitCode: 0 };
  } catch (err) {
    if (
      err instanceof CancelledFailure ||
      err instanceof PodmanCancelledError
    ) {
      rethrowIfCancelled(err);
    }
    log.warn("warmupSitespeedCache failed (continuing)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, exitCode: -1 };
  }
}

export async function measureSitespeed(
  handle: SitespeedRunHandle,
  input?: { runIndex?: number },
): Promise<{ exitCode: number; stdoutTail: string; stderrTail: string; runIndex: number }> {
  const env = getEnv();
  const runIndex = input?.runIndex ?? 1;
  const { exitCode, stdout, stderr } = await runSitespeedContainer({
    handle,
    phase: "measure",
    outputFolder: measureResultsContainerPath(runIndex),
    video: true,
    removeLighthouse: !env.sitespeedLighthouse,
    clearCache: handle.cacheMode !== "warm",
    chromeUserDataDir:
      handle.cacheMode === "warm" ? CONTAINER_CHROME_PROFILE : undefined,
    enableCpu: false,
    enableAxe: true,
    attachPotatoNetwork: true,
    runIndex,
  });

  if (exitCode !== 0) {
    throw new Error(
      summarizeSitespeedFailure(exitCode, `${stderr}\n${stdout}`),
    );
  }

  return {
    exitCode: 0,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    runIndex,
  };
}

/** Single post-measure pass with --cpu only (no video / axe / lighthouse). */
export async function measureSitespeedCpu(
  handle: SitespeedRunHandle,
): Promise<{ exitCode: number; stdoutTail: string; stderrTail: string }> {
  const { exitCode, stdout, stderr } = await runSitespeedContainer({
    handle,
    phase: "cpu",
    outputFolder: "/sitespeed.io/cpu-results",
    video: false,
    removeLighthouse: true,
    clearCache: handle.cacheMode !== "warm",
    chromeUserDataDir:
      handle.cacheMode === "warm" ? CONTAINER_CHROME_PROFILE : undefined,
    enableCpu: true,
    enableAxe: false,
    attachPotatoNetwork: true,
  });

  if (exitCode !== 0) {
    throw new Error(
      summarizeSitespeedFailure(exitCode, `${stderr}\n${stdout}`),
    );
  }

  return {
    exitCode: 0,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

export async function parseSitespeedMetrics(
  handle: SitespeedRunHandle,
  input?: { runIndex?: number },
): Promise<void> {
  heartbeat({ step: "parse-metrics" });
  const runIndex = input?.runIndex;
  const resultsRoot =
    runIndex !== undefined
      ? measureResultsHostPath(handle.runRoot, runIndex)
      : handle.resultsRoot;
  let metrics: SitespeedMetricsBundle = emptySitespeedMetricsBundle();
  try {
    metrics = await loadSitespeedMetrics(resultsRoot);
  } catch (err) {
    log.warn("Failed to parse sitespeed JSON", {
      err: err instanceof Error ? err.message : String(err),
      resultsRoot,
    });
  }
  const outPath =
    runIndex !== undefined
      ? potatoMetricsRunPath(handle.runRoot, runIndex)
      : potatoMetricsPath(handle.runRoot);
  await writeJsonFile(outPath, metrics);
}

export async function enrichFromPotato(
  handle: SitespeedRunHandle,
  input?: { runIndex?: number },
): Promise<void> {
  heartbeat({ step: "potato-enrichment" });
  const runIndex = input?.runIndex;

  let profile: PotatoProfile = {};
  let baseline: PotatoBaseline = {};
  let stats: PotatoStatsSnapshot = {
    dns: [],
    tlsClient: [],
    tlsUpstream: [],
    http: [],
    websocket: [],
  };
  let catalogCfRtt: number | undefined;
  let catalogNearestAwsRtt: number | undefined;
  let nearestAws: string | undefined;

  try {
    [profile, baseline, stats] = await Promise.all([
      getPotatoProfile(handle.potatoApiBaseUrl),
      getPotatoBaseline(handle.potatoApiBaseUrl),
      getPotatoStats(handle.potatoApiBaseUrl),
    ]);
    const country = await getPotatoCatalogCountry(
      handle.potatoApiBaseUrl,
      handle.country,
    );
    nearestAws = country?.nearestAws;
    const tier = country?.tiers?.[handle.tier];
    catalogCfRtt = tier?.rttToDest?.cf;
    if (nearestAws && tier?.rttToDest) {
      catalogNearestAwsRtt = tier.rttToDest[nearestAws];
    }
  } catch (err) {
    log.warn("Potato enrichment failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let metrics: SitespeedMetricsBundle = emptySitespeedMetricsBundle();
  try {
    const metricsPath =
      runIndex !== undefined
        ? potatoMetricsRunPath(handle.runRoot, runIndex)
        : potatoMetricsPath(handle.runRoot);
    metrics = await readJsonFile(metricsPath);
  } catch {
    // empty bundle
  }

  const firstIframeMs =
    typeof metrics.browsertime.firstIframeMs === "number"
      ? metrics.browsertime.firstIframeMs
      : typeof metrics.browsertime.firstIframeMs_median === "number"
        ? metrics.browsertime.firstIframeMs_median
        : undefined;
  const overlayTimeline = buildOverlayTimeline({
    events: stats.events ?? [],
    pageUrl: handle.url,
    workflowTld: handle.tld,
    firstIframeMs,
  });
  const overlayMeta: OverlayInfluxMeta = {
    wsMarkers: overlayTimeline.ws.length,
    apiMarkers: overlayTimeline.api.length,
    wsShown: lastN(overlayTimeline.ws, OVERLAY_SLOT_LIMIT).length,
    apiShown: lastN(overlayTimeline.api, OVERLAY_SLOT_LIMIT).length,
    firstIframeMs: overlayTimeline.firstIframeMs,
    burned: false,
  };

  const enrichment: PotatoEnrichmentDisk = {
    profile,
    baseline,
    stats,
    catalogCfRtt,
    catalogNearestAwsRtt,
    nearestAws,
    overlayTimeline,
    overlayMeta,
  };
  const outPath =
    runIndex !== undefined
      ? potatoEnrichmentRunPath(handle.runRoot, runIndex)
      : potatoEnrichmentPath(handle.runRoot);
  await writeJsonFile(outPath, enrichment);
}

/**
 * Load per-run metrics + enrichments, write aggregated potato-metrics /
 * potato-enrichment, and point resultsRoot at the median visual run.
 */
export async function aggregateMeasureRuns(
  handle: SitespeedRunHandle,
  input?: { runs?: number },
): Promise<{ resultsRoot: string; medianRunIndex: number }> {
  heartbeat({ step: "aggregate-measure-runs" });
  const runs = input?.runs ?? MEASURE_RUNS;
  const bundles: SitespeedMetricsBundle[] = [];
  const enrichments: PotatoEnrichmentDisk[] = [];

  for (let i = 1; i <= runs; i++) {
    try {
      bundles.push(
        await readJsonFile(potatoMetricsRunPath(handle.runRoot, i)),
      );
    } catch {
      bundles.push(emptySitespeedMetricsBundle());
    }
    try {
      enrichments.push(
        await readJsonFile(potatoEnrichmentRunPath(handle.runRoot, i)),
      );
    } catch {
      enrichments.push({
        profile: {},
        baseline: {},
        stats: {
          dns: [],
          tlsClient: [],
          tlsUpstream: [],
          http: [],
          websocket: [],
        },
        overlayTimeline: { markers: [], ws: [], api: [], firstIframeMs: 0 },
        overlayMeta: {
          wsMarkers: 0,
          apiMarkers: 0,
          wsShown: 0,
          apiShown: 0,
          firstIframeMs: 0,
          burned: false,
        },
      });
    }
  }

  const aggregated = stripCpuFromBundle(aggregateMetricsBundles(bundles));
  await writeJsonFile(potatoMetricsPath(handle.runRoot), aggregated);

  const pickValues = bundles.map((b) => {
    const v =
      b.browsertime.visual_SpeedIndex ??
      b.browsertime.pageLoadTime ??
      b.browsertime.fullyLoaded ??
      b.browsertime.firstIframeMs;
    return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
  });
  const medianIdx0 = medianSampleIndex(pickValues);
  const medianRunIndex = medianIdx0 + 1;
  const medianEnrichment = enrichments[medianIdx0]!;

  const aggregatedStats = aggregatePotatoStats(
    enrichments.map((e) => e.stats),
  );
  aggregatedStats.events = medianEnrichment.stats.events;
  aggregatedStats.slowHTTP = medianEnrichment.stats.slowHTTP;

  const enrichment: PotatoEnrichmentDisk = {
    profile: medianEnrichment.profile,
    baseline: medianEnrichment.baseline,
    stats: aggregatedStats,
    catalogCfRtt: medianEnrichment.catalogCfRtt,
    catalogNearestAwsRtt: medianEnrichment.catalogNearestAwsRtt,
    nearestAws: medianEnrichment.nearestAws,
    overlayTimeline: medianEnrichment.overlayTimeline,
    overlayMeta: medianEnrichment.overlayMeta,
  };
  await writeJsonFile(potatoEnrichmentPath(handle.runRoot), enrichment);

  const resultsRoot = measureResultsHostPath(handle.runRoot, medianRunIndex);
  log.info("Aggregated measure runs", {
    runs,
    medianRunIndex,
    resultsRoot,
    pickValues,
  });
  return { resultsRoot, medianRunIndex };
}

export async function parseSitespeedCpuMetrics(
  handle: SitespeedRunHandle,
): Promise<void> {
  heartbeat({ step: "parse-cpu-metrics" });
  const cpuRoot = join(handle.runRoot, "cpu-results");
  let metrics: SitespeedMetricsBundle = emptySitespeedMetricsBundle();
  try {
    metrics = filterCpuMetrics(await loadSitespeedMetrics(cpuRoot));
  } catch (err) {
    log.warn("Failed to parse CPU sitespeed JSON", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  await writeJsonFile(potatoCpuMetricsPath(handle.runRoot), metrics);
}

export async function burnPotatoOverlay(
  handle: SitespeedRunHandle,
): Promise<{ burned: boolean; potatoMp4?: string }> {
  heartbeat({ step: "overlay-burn" });
  const env = getEnv();
  const signal = activityCancelSignal();

  let enrichment: PotatoEnrichmentDisk;
  try {
    enrichment = await readJsonFile(potatoEnrichmentPath(handle.runRoot));
  } catch (err) {
    log.warn("No enrichment file for overlay burn", {
      err: err instanceof Error ? err.message : String(err),
    });
    const empty: PotatoOverlayResultDisk = { burned: false };
    await writeJsonFile(potatoOverlayResultPath(handle.runRoot), empty);
    return empty;
  }

  try {
    const sourceMp4 = await findLocalAsset(handle.resultsRoot, ".mp4");
    if (!sourceMp4) {
      log.warn("No mp4 found for potato overlay burn");
      const result: PotatoOverlayResultDisk = { burned: false };
      await writeJsonFile(potatoOverlayResultPath(handle.runRoot), result);
      enrichment.overlayMeta.burned = false;
      await writeJsonFile(potatoEnrichmentPath(handle.runRoot), enrichment);
      return result;
    }

    const browserSafe =
      handle.browser.replace(/[^a-zA-Z0-9_-]/g, "") || "chrome";
    const outputName = `${browserSafe}.potato.mp4`;
    const burned = await burnOverlayOntoVideo({
      inputMp4: sourceMp4,
      workDir: overlayWorkDirFor(sourceMp4),
      timeline: enrichment.overlayTimeline,
      sitespeedImage: env.sitespeedImage,
      outputName,
      signal,
      onTick: () => heartbeat({ step: "overlay-burn-running" }),
    });

    enrichment.overlayMeta.burned = true;
    await writeJsonFile(potatoEnrichmentPath(handle.runRoot), enrichment);

    const result: PotatoOverlayResultDisk = {
      burned: true,
      potatoMp4: burned.overlayMp4,
    };
    await writeJsonFile(potatoOverlayResultPath(handle.runRoot), result);
    log.info("Burned custom potato overlay", {
      sourceMp4,
      potatoMp4: burned.overlayMp4,
      ws: enrichment.overlayMeta.wsMarkers,
      api: enrichment.overlayMeta.apiMarkers,
    });
    return result;
  } catch (err) {
    if (
      err instanceof PodmanCancelledError ||
      signal.aborted ||
      err instanceof CancelledFailure
    ) {
      rethrowIfCancelled(err);
    }
    log.warn("Overlay burn failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    const result: PotatoOverlayResultDisk = { burned: false };
    await writeJsonFile(potatoOverlayResultPath(handle.runRoot), result);
    enrichment.overlayMeta.burned = false;
    await writeJsonFile(potatoEnrichmentPath(handle.runRoot), enrichment);
    return result;
  }
}

export async function emitInfluxMetrics(
  handle: SitespeedRunHandle,
): Promise<void> {
  heartbeat({ step: "influx-emit" });
  const env = getEnv();

  let metrics: SitespeedMetricsBundle = emptySitespeedMetricsBundle();
  try {
    metrics = await readJsonFile(potatoMetricsPath(handle.runRoot));
  } catch {
    // empty
  }

  let enrichment: PotatoEnrichmentDisk | undefined;
  try {
    enrichment = await readJsonFile(potatoEnrichmentPath(handle.runRoot));
  } catch {
    enrichment = undefined;
  }

  let overlayMeta = enrichment?.overlayMeta;
  try {
    const overlayResult = await readJsonFile<PotatoOverlayResultDisk>(
      potatoOverlayResultPath(handle.runRoot),
    );
    if (overlayMeta) {
      overlayMeta = { ...overlayMeta, burned: overlayResult.burned };
    }
  } catch {
    // optional
  }

  const tags = metricTagsFromDims({
    metricPrefix: handle.metricPrefix,
    country: handle.country,
    tier: handle.tier,
    cacheMode: handle.cacheMode,
    direct: handle.direct,
    isMirror: handle.isMirror,
    base: env.artifactNamespaceBase,
    browser: handle.browser,
    connectivity: "native",
  });

  const points = buildInfluxPoints({
    tags,
    workflowTld: handle.tld,
    browsertime: metrics.browsertime,
    browsertimeTagged: metrics.browsertimeTagged,
    pagexray: metrics.pagexray,
    pagexrayTagged: metrics.pagexrayTagged,
    coach: metrics.coach,
    axe: metrics.axe,
    lighthouse: metrics.lighthouse,
    sustainable: metrics.sustainable,
    thirdparty: metrics.thirdparty,
    thirdpartyTagged: metrics.thirdpartyTagged,
    profile: enrichment?.profile ?? {},
    baseline: enrichment?.baseline ?? {},
    catalogCfRtt: enrichment?.catalogCfRtt,
    catalogNearestAwsRtt: enrichment?.catalogNearestAwsRtt,
    nearestAws: enrichment?.nearestAws,
    stats: enrichment?.stats ?? {
      dns: [],
      tlsClient: [],
      tlsUpstream: [],
      http: [],
      websocket: [],
    },
    overlay: overlayMeta,
  });

  const emit = await emitInfluxWrite(
    env.influxWriteUrl,
    points,
    {
      username: env.influxWriteUsername,
      password: env.influxWritePassword,
      token: env.influxWriteToken,
    },
    { timeoutMs: env.influxWriteTimeoutMs },
  );
  log.info("Influx write", emit);
}

/** Emit only CPU fields from the dedicated cpu-results pass. */
export async function emitInfluxCpuMetrics(
  handle: SitespeedRunHandle,
): Promise<void> {
  heartbeat({ step: "influx-emit-cpu" });
  const env = getEnv();

  let metrics: SitespeedMetricsBundle = emptySitespeedMetricsBundle();
  try {
    metrics = filterCpuMetrics(
      await readJsonFile(potatoCpuMetricsPath(handle.runRoot)),
    );
  } catch {
    // empty
  }

  if (
    Object.keys(metrics.browsertime).length === 0 &&
    metrics.browsertimeTagged.length === 0
  ) {
    log.warn("No CPU metrics to emit");
    return;
  }

  const tags = metricTagsFromDims({
    metricPrefix: handle.metricPrefix,
    country: handle.country,
    tier: handle.tier,
    cacheMode: handle.cacheMode,
    direct: handle.direct,
    isMirror: handle.isMirror,
    base: env.artifactNamespaceBase,
    browser: handle.browser,
    connectivity: "native",
  });

  const points = buildInfluxPoints({
    tags,
    workflowTld: handle.tld,
    browsertime: metrics.browsertime,
    browsertimeTagged: metrics.browsertimeTagged,
    profile: {},
    baseline: {},
    stats: {
      dns: [],
      tlsClient: [],
      tlsUpstream: [],
      http: [],
      websocket: [],
    },
  }).filter((p) => p.measurement === "potato_browsertime");

  const emit = await emitInfluxWrite(
    env.influxWriteUrl,
    points,
    {
      username: env.influxWriteUsername,
      password: env.influxWritePassword,
      token: env.influxWriteToken,
    },
    { timeoutMs: env.influxWriteTimeoutMs },
  );
  log.info("Influx CPU write", emit);
}

export async function uploadSitespeedArtifacts(
  handle: SitespeedRunHandle,
): Promise<{ s3Keys?: string[] }> {
  const env = getEnv();
  if (!env.s3Bucket || !env.s3Key || !env.s3Secret) {
    return {};
  }

  heartbeat({ step: "s3-upload" });
  let potatoMp4: string | undefined;
  try {
    const overlayResult = await readJsonFile<PotatoOverlayResultDisk>(
      potatoOverlayResultPath(handle.runRoot),
    );
    potatoMp4 = overlayResult.potatoMp4;
  } catch {
    // optional
  }

  const uploaded = await uploadLocalSitespeedArtifacts({
    resultRoot: handle.resultsRoot,
    bucket: env.s3Bucket,
    accessKeyId: env.s3Key,
    secretAccessKey: env.s3Secret,
    region: env.s3Region,
    endpoint: env.s3Endpoint,
    forcePathStyle: env.s3ForcePathStyle,
    latestPrefix: handle.artifactNamespace,
    browser: handle.browser,
    connectivity: "native",
    potatoMp4,
  });
  log.info("Uploaded local sitespeed artifacts to S3", uploaded);
  return { s3Keys: uploaded.uploaded };
}
