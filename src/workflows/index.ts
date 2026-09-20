import {
  CancellationScope,
  isCancellation,
  log,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities/index";
import { normalizeSiteSpeedInput } from "../shared/entry-url";
import { sitespeedActivityMaxAttempts } from "../shared/sitespeed-attempts";
import type {
  PotatoRefreshResult,
  SiteSpeedTestInput,
  SiteSpeedTestResult,
  SitespeedRunHandle,
} from "../shared/types";

const {
  ensurePotatoVolume,
  startPotato,
  waitPotatoHealthy,
  stopPotato,
  refreshPotatoCatalog,
  refreshPotatoBaseline,
  resolveEntryUrl,
  deleteMasterSession,
  pullUsedImages,
  resetPotatoStats,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
  },
});

const { prepareSitespeedRun, parseSitespeedMetrics, enrichFromPotato } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "30 minutes",
    heartbeatTimeout: "2 minutes",
    retry: {
      maximumAttempts: 3,
      initialInterval: "5s",
      backoffCoefficient: 2,
    },
  });

const { warmupSitespeedCache, measureSitespeed } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "90 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: sitespeedActivityMaxAttempts(),
    initialInterval: "10s",
    backoffCoefficient: 2,
  },
});

const { burnPotatoOverlay, emitInfluxMetrics, uploadSitespeedArtifacts } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "30 minutes",
    heartbeatTimeout: "2 minutes",
    retry: {
      maximumAttempts: 2,
      initialInterval: "5s",
      backoffCoefficient: 2,
    },
  });

export async function siteSpeedTestWorkflow(
  input: SiteSpeedTestInput,
): Promise<SiteSpeedTestResult> {
  const normalized = normalizeSiteSpeedInput(input);
  const { runId } = workflowInfo();

  // Auth + session URL resolution runs on the worker host (not through PotatoNetwork).
  const entry = await resolveEntryUrl({
    tld: normalized.tld,
    tableId: normalized.tableId,
    direct: normalized.direct,
  });

  try {
    await ensurePotatoVolume();

    const potato = await startPotato({
      runId,
      country: normalized.country,
      tier: normalized.tier,
      namePrefix: "potato-ss",
    });

    let handle: SitespeedRunHandle | undefined;
    let measureExitCode = 0;

    try {
      await waitPotatoHealthy(potato);

      handle = await prepareSitespeedRun({
        potatoContainer: potato.containerName,
        potatoApiBaseUrl: potato.apiBaseUrl,
        url: entry.frameUrl,
        metricPrefix: normalized.metricPrefix,
        country: normalized.country,
        tier: normalized.tier,
        tld: normalized.tld,
        browser: normalized.browser,
        cacheMode: normalized.cacheMode,
        direct: normalized.direct,
        cpuThrottlingRate: normalized.cpuThrottlingRate,
      });

      if (normalized.cacheMode === "warm") {
        await warmupSitespeedCache(handle);
        await resetPotatoStats(potato);
      }

      const measured = await measureSitespeed(handle);
      measureExitCode = measured.exitCode;

      await parseSitespeedMetrics(handle);
      await enrichFromPotato(handle);
    } finally {
      // Always tear down Potato even when the workflow is cancelled mid-run.
      await CancellationScope.nonCancellable(async () => {
        await stopPotato(potato);
      });
    }

    // Post-Potato steps (overlay / Influx / S3). Not reached if measure/enrich
    // threw (including cancel) — error rethrows after the Potato finally.
    if (!handle) {
      throw new Error("sitespeed run handle missing after measure");
    }

    try {
      await burnPotatoOverlay(handle);
    } catch (err) {
      if (isCancellation(err)) throw err;
      log.warn("burnPotatoOverlay failed (non-fatal)", { err });
    }

    try {
      await emitInfluxMetrics(handle);
    } catch (err) {
      if (isCancellation(err)) throw err;
      log.warn("emitInfluxMetrics failed (non-fatal)", { err });
    }

    try {
      await uploadSitespeedArtifacts(handle);
    } catch (err) {
      if (isCancellation(err)) throw err;
      log.warn("uploadSitespeedArtifacts failed (non-fatal)", { err });
    }

    return {
      url: entry.frameUrl,
      msid: entry.msid,
      mode: entry.mode,
      metricPrefix: normalized.metricPrefix,
      cacheMode: normalized.cacheMode,
      direct: normalized.direct,
      isMirror: handle.isMirror,
      artifactNamespace: handle.artifactNamespace,
      graphiteNamespace: handle.artifactNamespace,
      potatoContainer: potato.containerName,
      sitespeedExitCode: measureExitCode,
    };
  } finally {
    // Always delete the demo master session (success, failure, or cancel).
    await CancellationScope.nonCancellable(async () => {
      await deleteMasterSession({
        tld: normalized.tld,
        msid: entry.msid,
      });
    });
  }
}

/** Stable workflow id recommended: "potato-refresh" */
export async function potatoRefreshWorkflow(): Promise<PotatoRefreshResult> {
  const { runId } = workflowInfo();

  const pulled = await pullUsedImages();
  await ensurePotatoVolume();

  const potato = await startPotato({
    runId,
    namePrefix: "potato-refresh",
    // passthrough — no country profile for maintenance
  });

  try {
    await waitPotatoHealthy(potato);
    const catalog = await refreshPotatoCatalog(potato);
    const baseline = await refreshPotatoBaseline(potato);

    return {
      potatoContainer: potato.containerName,
      catalogOk: catalog.ok === true,
      baselineProbedAt: baseline.probedAt,
      pulledImages: pulled.images,
    };
  } finally {
    await CancellationScope.nonCancellable(async () => {
      await stopPotato(potato);
    });
  }
}
