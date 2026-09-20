import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { heartbeat, log } from "@temporalio/activity";
import {
  getPotatoBaseline,
  getPotatoCatalogCountry,
  getPotatoProfile,
  getPotatoStats,
  resetPotatoStats,
  type PotatoStatsRequest,
  type PotatoStatsSnapshot,
} from "./potato";
import { assertExportConfig, getEnv } from "../lib/env";
import { buildMeasureJourneyScript } from "../lib/bt-measure-journey";
import {
  scrubHostForMetrics,
  scrubPathForMetrics,
} from "../lib/metric-scrub";
import {
  buildOverlayTimeline,
  lastN,
  OVERLAY_SLOT_LIMIT,
} from "../lib/overlay-timeline";
import { uploadLocalSitespeedArtifacts } from "../lib/s3-latest";
import { podman } from "../lib/podman";
import {
  loadSitespeedMetricFields,
  type SitespeedTimingFields,
} from "../lib/sitespeed-json";
import {
  emitInfluxWrite,
  type InfluxPoint,
} from "../lib/influx";
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
} from "../shared/sitespeed-args";
import { sitespeedPotatoEntrypoint } from "../shared/sitespeed-entrypoint";
import type { CacheMode, PotatoTier } from "../shared/types";

export { CHROME_DEVICE_NAME } from "../shared/sitespeed-args";

const CONTAINER_OUTPUT = "/sitespeed.io/results";
const CONTAINER_FIRST_IFRAME_SCRIPT = "/sitespeed.io/bt-first-iframe.js";
const CONTAINER_MEASURE_JOURNEY = "/sitespeed.io/bt-measure-journey.js";
const HOST_FIRST_IFRAME_SCRIPT = fileURLToPath(
  new URL("../../scripts/bt-first-iframe.js", import.meta.url),
);

export type RunSitespeedInput = {
  potatoContainer: string;
  /** Potato API base (host-published :7783) for profile/stats enrichment */
  potatoApiBaseUrl: string;
  url: string;
  metricPrefix: string;
  country: string;
  tier: PotatoTier;
  /** Workflow tld — isMirror + host scrub → `{tld}` in Telegraf tags */
  tld: string;
  browser: string;
  cacheMode: CacheMode;
  /** Folded into artifact namespace / Telegraf tags */
  direct: boolean;
  /** Chrome CPUThrottlingRate when set (integer ≥ 1). */
  cpuThrottlingRate?: number;
};

export type RunSitespeedResult = {
  exitCode: number;
  /** Dotted prefix for S3 / Grafana (`sitespeed.lobby.BD…`) */
  artifactNamespace: string;
  /** @deprecated alias of artifactNamespace */
  graphiteNamespace: string;
  slug: string;
  isMirror: boolean;
  resultDir: string;
  s3Keys?: string[];
  stdoutTail: string;
  stderrTail: string;
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

function sitespeedEntrypointCmd(args: string[]): {
  entrypoint: string[];
  cmd: string[];
} {
  return sitespeedPotatoEntrypoint(args);
}

function avgLatency(sumMs: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  return sumMs / count;
}

function scrubDomainTag(domain: string, workflowTld: string): string {
  return scrubHostForMetrics(domain, workflowTld);
}

function requestTags(
  base: Record<string, string>,
  req: PotatoStatsRequest,
  workflowTld: string,
): Record<string, string> {
  const out: Record<string, string> = {
    ...base,
    host: scrubHostForMetrics(req.host, workflowTld),
    path: scrubPathForMetrics(req.path),
  };
  if (req.method) out.method = req.method.toUpperCase();
  return out;
}

function latencyFields(
  req: PotatoStatsRequest,
): Record<string, number | undefined> {
  return {
    count: req.count,
    started: req.started,
    errorCount: req.errorCount,
    latencySumMs: req.latencyMs.sumMs,
    latencyMinMs: req.latencyMs.minMs,
    latencyMaxMs: req.latencyMs.maxMs,
    latencyAvgMs: avgLatency(req.latencyMs.sumMs, req.count),
  };
}

export function buildInfluxPoints(input: {
  tags: Record<string, string>;
  workflowTld: string;
  browsertime: SitespeedTimingFields;
  profile: Awaited<ReturnType<typeof getPotatoProfile>>;
  baseline: Awaited<ReturnType<typeof getPotatoBaseline>>;
  catalogCfRtt?: number;
  catalogNearestAwsRtt?: number;
  nearestAws?: string;
  stats: PotatoStatsSnapshot;
  overlay?: {
    wsMarkers: number;
    apiMarkers: number;
    wsShown: number;
    apiShown: number;
    firstIframeMs: number;
    burned: boolean;
  };
}): InfluxPoint[] {
  const points: InfluxPoint[] = [];
  const { tags, workflowTld } = input;

  if (Object.keys(input.browsertime).length) {
    points.push({
      measurement: "sitespeed_browsertime",
      tags,
      fields: input.browsertime,
    });
  }

  const profileFields: Record<string, number | boolean | undefined> = {
    delayMs: input.profile.delayMs,
    downloadMbps: input.profile.downloadMbps,
    uploadMbps: input.profile.uploadMbps,
    lossPercent: input.profile.lossPercent,
    emulationLimited: input.profile.emulationLimited ? true : false,
    passthrough: input.profile.passthrough ? true : false,
    hostCfRttMs: input.baseline.hostRtt?.cf,
    cfRttMs: input.catalogCfRtt,
    nearestAwsRttMs: input.catalogNearestAwsRtt,
  };
  points.push({
    measurement: "potato_profile",
    tags: {
      ...tags,
      ...(input.nearestAws ? { nearestAws: input.nearestAws } : {}),
    },
    fields: profileFields,
  });

  for (const d of input.stats.dns ?? []) {
    points.push({
      measurement: "potato_dns",
      tags: { ...tags, domain: scrubDomainTag(d.domain, workflowTld) },
      fields: {
        count: d.count,
        errorCount: d.errorCount,
        latencySumMs: d.latencyMs.sumMs,
        latencyMinMs: d.latencyMs.minMs,
        latencyMaxMs: d.latencyMs.maxMs,
        latencyAvgMs: avgLatency(d.latencyMs.sumMs, d.count),
      },
    });
  }
  for (const d of input.stats.tlsClient ?? []) {
    points.push({
      measurement: "potato_tls_client",
      tags: { ...tags, domain: scrubDomainTag(d.domain, workflowTld) },
      fields: {
        count: d.count,
        errorCount: d.errorCount,
        latencySumMs: d.latencyMs.sumMs,
        latencyMinMs: d.latencyMs.minMs,
        latencyMaxMs: d.latencyMs.maxMs,
        latencyAvgMs: avgLatency(d.latencyMs.sumMs, d.count),
      },
    });
  }
  for (const d of input.stats.tlsUpstream ?? []) {
    points.push({
      measurement: "potato_tls_upstream",
      tags: { ...tags, domain: scrubDomainTag(d.domain, workflowTld) },
      fields: {
        count: d.count,
        errorCount: d.errorCount,
        latencySumMs: d.latencyMs.sumMs,
        latencyMinMs: d.latencyMs.minMs,
        latencyMaxMs: d.latencyMs.maxMs,
        latencyAvgMs: avgLatency(d.latencyMs.sumMs, d.count),
      },
    });
  }

  for (const req of input.stats.http ?? []) {
    const rtags = requestTags(tags, req, workflowTld);
    points.push({
      measurement: "potato_http",
      tags: rtags,
      fields: latencyFields(req),
    });
    if (req.count > 1) {
      points.push({
        measurement: "potato_http_duplicate",
        tags: rtags,
        fields: {
          count: req.count,
          extraCount: req.count - 1,
          latencySumMs: req.latencyMs.sumMs,
          latencyAvgMs: avgLatency(req.latencyMs.sumMs, req.count),
        },
      });
    }
  }

  for (const req of input.stats.websocket ?? []) {
    points.push({
      measurement: "potato_websocket",
      tags: requestTags(tags, req, workflowTld),
      fields: {
        ...latencyFields(req),
        started: req.started ?? 0,
      },
    });
  }

  const slow = input.stats.slowHTTP ?? [];
  for (let i = 0; i < slow.length; i++) {
    const sample = slow[i]!;
    points.push({
      measurement: "potato_http_slow",
      tags: {
        ...tags,
        rank: String(i + 1),
        host: scrubHostForMetrics(sample.host, workflowTld),
        method: (sample.method || "GET").toUpperCase(),
        path: scrubPathForMetrics(sample.path),
      },
      fields: {
        durationMs: sample.durationMs,
        failed: sample.failed ? true : false,
      },
    });
  }

  const cf = input.stats.cfCache;
  if (cf) {
    const statuses = Object.keys(cf).sort();
    for (const status of statuses) {
      const count = cf[status];
      if (typeof count !== "number" || !Number.isFinite(count)) continue;
      points.push({
        measurement: "potato_cf_cache",
        tags: { ...tags, status },
        fields: { count },
      });
    }
  }

  if (input.overlay) {
    points.push({
      measurement: "potato_overlay",
      tags,
      fields: {
        wsMarkers: input.overlay.wsMarkers,
        apiMarkers: input.overlay.apiMarkers,
        wsShown: input.overlay.wsShown,
        apiShown: input.overlay.apiShown,
        firstIframeMs: input.overlay.firstIframeMs,
        burned: input.overlay.burned ? true : false,
      },
    });
  }

  return points;
}

export async function runSitespeed(
  input: RunSitespeedInput,
): Promise<RunSitespeedResult> {
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
  const tags = metricTagsFromDims({
    ...dims,
    browser: input.browser,
    connectivity: "native",
  });

  const resultDir = join(
    env.sitespeedResultsDir,
    `${slug}-${Date.now()}`,
  );
  await mkdir(resultDir, { recursive: true });
  const chromeProfileDir = join(resultDir, "chrome-profile");
  if (input.cacheMode === "warm") {
    await mkdir(chromeProfileDir, { recursive: true });
  }

  try {
    await copyFile(
      HOST_FIRST_IFRAME_SCRIPT,
      join(resultDir, "bt-first-iframe.js"),
    );
    await writeFile(
      join(resultDir, "bt-measure-journey.js"),
      buildMeasureJourneyScript({
        url: input.url,
        alias: input.metricPrefix,
      }),
      "utf8",
    );
  } catch (err) {
    throw new Error(
      `Failed to stage browsertime scripts into ${resultDir}: ${
        err instanceof Error ? err.message : String(err)
      } (src=${HOST_FIRST_IFRAME_SCRIPT})`,
    );
  }

  const runSitespeedContainer = async (opts: {
    phase: "warmup" | "measure";
    outputFolder: string;
    video: boolean;
    removeLighthouse: boolean;
    clearCache: boolean;
    chromeUserDataDir?: string;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const cmd = buildSitespeedBrowserArgs({
      browser: input.browser,
      slug:
        opts.phase === "warmup" ? `${slug}-warmup` : slug,
      metricPrefix: input.metricPrefix,
      cacheMode: input.cacheMode,
      url: input.url,
      outputFolder: opts.outputFolder,
      scriptPath: CONTAINER_FIRST_IFRAME_SCRIPT,
      multiScriptPath: CONTAINER_MEASURE_JOURNEY,
      removeLighthouse: opts.removeLighthouse,
      removeGpsi: true,
      cpuThrottlingRate: input.cpuThrottlingRate,
      chromeUserDataDir: opts.chromeUserDataDir,
      video: opts.video,
      clearCache: opts.clearCache,
    });

    const containerName = `sitespeed-${slug}-${opts.phase}-${Date.now()}`;
    log.info("Starting sitespeed.io", {
      phase: opts.phase,
      potatoContainer: input.potatoContainer,
      url: input.url,
      artifactNamespace,
      slug,
      resultDir,
      cacheMode: input.cacheMode,
      cpuThrottlingRate: input.cpuThrottlingRate ?? null,
      chromeUserDataDir: opts.chromeUserDataDir ?? null,
      country: input.country,
      tier: input.tier,
      isMirror,
      tld: input.tld,
      direct: input.direct,
      deviceName: CHROME_DEVICE_NAME,
    });

    heartbeat({ step: `sitespeed-${opts.phase}` });
    const { entrypoint, cmd: wrappedCmd } = sitespeedEntrypointCmd(cmd);
    return podman.runToCompletion(
      {
        name: containerName,
        image: env.sitespeedImage,
        entrypoint,
        cmd: wrappedCmd,
        networkMode: `container:${input.potatoContainer}`,
        binds: [
          `${env.potatoDataVolume}:/potato-data:ro`,
          `${resultDir}:/sitespeed.io`,
        ],
        env: {
          NODE_EXTRA_CA_CERTS: "/potato-data/ca/potatonetwork-ca.pem",
        },
        shmSizeBytes: 2 * 1024 * 1024 * 1024,
      },
      () => heartbeat({ step: `sitespeed-${opts.phase}-running` }),
    );
  };

  if (input.cacheMode === "warm") {
    const warmup = await runSitespeedContainer({
      phase: "warmup",
      outputFolder: "/sitespeed.io/warmup-results",
      video: false,
      removeLighthouse: true,
      clearCache: false,
      chromeUserDataDir: CONTAINER_CHROME_PROFILE,
    });
    if (warmup.exitCode !== 0) {
      throw new Error(
        summarizeSitespeedFailure(
          warmup.exitCode,
          `${warmup.stderr}\n${warmup.stdout}`,
        ),
      );
    }
    heartbeat({ step: "potato-stats-reset" });
    await resetPotatoStats(input.potatoApiBaseUrl);
    log.info("Potato stats reset after warm cache fill");
  }

  const { exitCode, stdout, stderr } = await runSitespeedContainer({
    phase: "measure",
    outputFolder: CONTAINER_OUTPUT,
    video: true,
    removeLighthouse: !env.sitespeedLighthouse,
    clearCache: input.cacheMode !== "warm",
    chromeUserDataDir:
      input.cacheMode === "warm" ? CONTAINER_CHROME_PROFILE : undefined,
  });

  const combined = `${stderr}\n${stdout}`;
  if (exitCode !== 0) {
    throw new Error(summarizeSitespeedFailure(exitCode, combined));
  }

  const hostResultsRoot = join(resultDir, "results");

  heartbeat({ step: "parse-metrics" });
  let browsertime: SitespeedTimingFields = {};
  try {
    browsertime = await loadSitespeedMetricFields(hostResultsRoot);
  } catch (err) {
    log.warn("Failed to parse sitespeed JSON", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  heartbeat({ step: "potato-enrichment" });
  let profile: Awaited<ReturnType<typeof getPotatoProfile>> = {};
  let baseline: Awaited<ReturnType<typeof getPotatoBaseline>> = {};
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
      getPotatoProfile(input.potatoApiBaseUrl),
      getPotatoBaseline(input.potatoApiBaseUrl),
      getPotatoStats(input.potatoApiBaseUrl),
    ]);
    const country = await getPotatoCatalogCountry(
      input.potatoApiBaseUrl,
      input.country,
    );
    nearestAws = country?.nearestAws;
    const tier = country?.tiers?.[input.tier];
    catalogCfRtt = tier?.rttToDest?.cf;
    if (nearestAws && tier?.rttToDest) {
      catalogNearestAwsRtt = tier.rttToDest[nearestAws];
    }
  } catch (err) {
    log.warn("Potato enrichment failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let overlayMeta: {
    wsMarkers: number;
    apiMarkers: number;
    wsShown: number;
    apiShown: number;
    firstIframeMs: number;
    burned: boolean;
  } | undefined;

  // Event marker counts for metrics only — video uses browsertime's built-in timer.
  heartbeat({ step: "overlay-metrics" });
  try {
    const firstIframeMs =
      typeof browsertime.firstIframeMs === "number"
        ? browsertime.firstIframeMs
        : undefined;
    const timeline = buildOverlayTimeline({
      events: stats.events ?? [],
      pageUrl: input.url,
      workflowTld: input.tld,
      firstIframeMs,
    });
    overlayMeta = {
      wsMarkers: timeline.ws.length,
      apiMarkers: timeline.api.length,
      wsShown: lastN(timeline.ws, OVERLAY_SLOT_LIMIT).length,
      apiShown: lastN(timeline.api, OVERLAY_SLOT_LIMIT).length,
      firstIframeMs: timeline.firstIframeMs,
      burned: false,
    };
  } catch (err) {
    log.warn("Overlay metric extract failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  heartbeat({ step: "influx-emit" });
  try {
    const points = buildInfluxPoints({
      tags,
      workflowTld: input.tld,
      browsertime,
      profile,
      baseline,
      catalogCfRtt,
      catalogNearestAwsRtt,
      nearestAws,
      stats,
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
  } catch (err) {
    log.warn("Influx write failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let s3Keys: string[] | undefined;
  if (env.s3Bucket && env.s3Key && env.s3Secret) {
    heartbeat({ step: "s3-upload" });
    try {
      const uploaded = await uploadLocalSitespeedArtifacts({
        resultRoot: hostResultsRoot,
        bucket: env.s3Bucket,
        accessKeyId: env.s3Key,
        secretAccessKey: env.s3Secret,
        region: env.s3Region,
        endpoint: env.s3Endpoint,
        forcePathStyle: env.s3ForcePathStyle,
        latestPrefix: artifactNamespace,
        browser: input.browser,
        connectivity: "native",
      });
      s3Keys = uploaded.uploaded;
      log.info("Uploaded local sitespeed artifacts to S3", uploaded);
    } catch (err) {
      log.warn("S3 upload failed", {
        err: err instanceof Error ? err.message : String(err),
        slug,
        artifactNamespace,
      });
    }
  }

  return {
    exitCode: 0,
    artifactNamespace,
    graphiteNamespace: artifactNamespace,
    slug,
    isMirror,
    resultDir: hostResultsRoot,
    s3Keys,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}
