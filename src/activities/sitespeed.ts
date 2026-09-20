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
  type PotatoStatsSnapshot,
} from "./potato";
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
} from "../lib/sitespeed-json";
import {
  potatoEnrichmentPath,
  potatoMetricsPath,
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
} from "../shared/sitespeed-args";
import { sitespeedPotatoEntrypoint } from "../shared/sitespeed-entrypoint";
import type {
  CacheMode,
  PotatoTier,
  SitespeedRunHandle,
} from "../shared/types";

export { CHROME_DEVICE_NAME } from "../shared/sitespeed-args";
export { buildInfluxPoints } from "../lib/influx-points";

const CONTAINER_OUTPUT = "/sitespeed.io/results";
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

async function runSitespeedContainer(opts: {
  handle: SitespeedRunHandle;
  phase: "warmup" | "measure";
  outputFolder: string;
  video: boolean;
  removeLighthouse: boolean;
  clearCache: boolean;
  chromeUserDataDir?: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = getEnv();
  const { handle } = opts;

  const cmd = buildSitespeedBrowserArgs({
    browser: handle.browser,
    slug: opts.phase === "warmup" ? `${handle.slug}-warmup` : handle.slug,
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
  });

  const containerName = `sitespeed-${handle.slug}-${opts.phase}-${Date.now()}`;
  log.info("Starting sitespeed.io", {
    phase: opts.phase,
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
  const { entrypoint, cmd: wrappedCmd } = sitespeedPotatoEntrypoint(cmd);
  const signal = activityCancelSignal();
  try {
    return await podman.runToCompletion(
      {
        name: containerName,
        image: env.sitespeedImage,
        entrypoint,
        cmd: wrappedCmd,
        networkMode: `container:${handle.potatoContainer}`,
        binds: [
          `${env.potatoDataVolume}:/potato-data:ro`,
          `${handle.runRoot}:/sitespeed.io`,
        ],
        env: {
          NODE_EXTRA_CA_CERTS: "/potato-data/ca/potatonetwork-ca.pem",
        },
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
    resultsRoot: join(runRoot, "results"),
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

export async function warmupSitespeedCache(
  handle: SitespeedRunHandle,
): Promise<void> {
  const warmup = await runSitespeedContainer({
    handle,
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
}

export async function measureSitespeed(
  handle: SitespeedRunHandle,
): Promise<{ exitCode: number; stdoutTail: string; stderrTail: string }> {
  const env = getEnv();
  const { exitCode, stdout, stderr } = await runSitespeedContainer({
    handle,
    phase: "measure",
    outputFolder: CONTAINER_OUTPUT,
    video: true,
    removeLighthouse: !env.sitespeedLighthouse,
    clearCache: handle.cacheMode !== "warm",
    chromeUserDataDir:
      handle.cacheMode === "warm" ? CONTAINER_CHROME_PROFILE : undefined,
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
): Promise<void> {
  heartbeat({ step: "parse-metrics" });
  let metrics: SitespeedMetricsBundle = emptySitespeedMetricsBundle();
  try {
    metrics = await loadSitespeedMetrics(handle.resultsRoot);
  } catch (err) {
    log.warn("Failed to parse sitespeed JSON", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  await writeJsonFile(potatoMetricsPath(handle.runRoot), metrics);
}

export async function enrichFromPotato(
  handle: SitespeedRunHandle,
): Promise<void> {
  heartbeat({ step: "potato-enrichment" });

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
    metrics = await readJsonFile(potatoMetricsPath(handle.runRoot));
  } catch {
    // empty bundle
  }

  const firstIframeMs =
    typeof metrics.browsertime.firstIframeMs === "number"
      ? metrics.browsertime.firstIframeMs
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
  await writeJsonFile(potatoEnrichmentPath(handle.runRoot), enrichment);
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
