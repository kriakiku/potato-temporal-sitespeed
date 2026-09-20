import {
  CancellationScope,
  executeChild,
  isCancellation,
  log,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities/index";
import { MEASURE_RUNS } from "../shared/sitespeed-args";
import { normalizeSiteSpeedInput } from "../shared/entry-url";
import type {
  AutostartTickResult,
  PotatoRefreshResult,
  SiteSpeedTestInput,
  SiteSpeedTestResult,
  SitespeedRunHandle,
} from "../shared/types";

const { resolveEntryUrl, deleteMasterSession } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 2,
    initialInterval: "5s",
    backoffCoefficient: 2,
  },
});

const {
  ensurePotatoVolume,
  ensurePotato,
  startPotato,
  waitPotatoHealthy,
  stopPotato,
  resetPotatoStats,
  refreshPotatoCatalog,
  refreshPotatoBaseline,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 1,
  },
});

/** Cleanup can be slow on a busy Podman host — longer heartbeat window. */
const { stopAllPotatoContainers, pruneEngineResources } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "5 minutes",
  retry: {
    maximumAttempts: 1,
  },
});

const {
  prepareSitespeedRun,
  parseSitespeedMetrics,
  parseSitespeedCpuMetrics,
  enrichFromPotato,
  aggregateMeasureRuns,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 1,
  },
});

/** Slim cache fill — soft ~2m budget; failures are non-fatal inside the activity. */
const { warmupSitespeedCache } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "1 minute",
  retry: {
    maximumAttempts: 1,
  },
});

const { measureSitespeed, measureSitespeedCpu } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "90 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 1,
  },
});

const {
  burnPotatoOverlay,
  emitInfluxMetrics,
  emitInfluxCpuMetrics,
  uploadSitespeedArtifacts,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 1,
  },
});

const { planAutostartTick, startAutostartSitespeed } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 1,
  },
});

export async function siteSpeedTestWorkflow(
  input: SiteSpeedTestInput,
): Promise<SiteSpeedTestResult> {
  const normalized = normalizeSiteSpeedInput(input);

  // Auth + session URL resolution runs on the worker host (not through PotatoNetwork).
  const entry = await resolveEntryUrl({
    tld: normalized.tld,
    tableId: normalized.tableId,
    direct: normalized.direct,
    country: normalized.country,
    locale: normalized.locale,
    currency: normalized.currency,
  });

  let potato: Awaited<ReturnType<typeof ensurePotato>> | undefined;
  let handle: SitespeedRunHandle | undefined;
  let measureExitCode = 0;

  try {
    await ensurePotatoVolume();

    potato = await ensurePotato({
      country: normalized.country,
      tier: normalized.tier,
    });
    await waitPotatoHealthy(potato);
    await resetPotatoStats(potato);

    try {
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
        try {
          await warmupSitespeedCache(handle);
        } catch (err) {
          // Activity soft-timeout / unexpected throw — keep whatever profile exists.
          if (isCancellation(err)) throw err;
          log.warn("warmupSitespeedCache failed (continuing)", { err });
        }
      }

      for (let runIndex = 1; runIndex <= MEASURE_RUNS; runIndex++) {
        await resetPotatoStats(potato);
        const measured = await measureSitespeed(handle, { runIndex });
        measureExitCode = measured.exitCode;
        await parseSitespeedMetrics(handle, { runIndex });
        await enrichFromPotato(handle, { runIndex });
      }

      const agg = await aggregateMeasureRuns(handle, { runs: MEASURE_RUNS });
      handle = { ...handle, resultsRoot: agg.resultsRoot };

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

      // Dedicated CPU pass — only CPU fields go to Influx.
      await resetPotatoStats(potato);
      await measureSitespeedCpu(handle);
      await parseSitespeedCpuMetrics(handle);
      try {
        await emitInfluxCpuMetrics(handle);
      } catch (err) {
        if (isCancellation(err)) throw err;
        log.warn("emitInfluxCpuMetrics failed (non-fatal)", { err });
      }
    } finally {
      if (potato) {
        await CancellationScope.nonCancellable(async () => {
          await resetPotatoStats(potato!);
        });
      }
    }

    if (!handle || !potato) {
      throw new Error("sitespeed run handle missing after measure");
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

/**
 * Stable workflow id recommended: "potato-refresh".
 * Tears down Potato sidecars, prunes stale engine disk usage (no image pull),
 * then refreshes catalog/baseline on a short-lived passthrough container.
 */
export async function potatoRefreshWorkflow(): Promise<PotatoRefreshResult> {
  const { runId } = workflowInfo();

  let pruneSummary = {
    removedContainers: 0,
    removedVolumes: 0,
    removedResultDirs: 0,
  };

  await CancellationScope.nonCancellable(async () => {
    await stopAllPotatoContainers();
    const pruned = await pruneEngineResources();
    pruneSummary = {
      removedContainers: pruned.removedContainers.length,
      removedVolumes: pruned.removedVolumes.length,
      removedResultDirs: pruned.removedResultDirs.length,
    };
  });

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
      prune: pruneSummary,
    };
  } finally {
    await CancellationScope.nonCancellable(async () => {
      await stopPotato(potato);
    });
  }
}

/**
 * Schedule tick: skip if any non-autostart workflow is Running on the queue;
 * otherwise start next JSON job (potatoRefresh first when index is 0).
 *
 * Refresh runs as a child workflow so we never hold the sole activity slot
 * while Potato refresh activities need to run (MAX_CONCURRENT_ACTIVITIES=1).
 */
export async function autostartWorkflow(): Promise<AutostartTickResult> {
  const { workflowId, runId } = workflowInfo();
  const plan = await planAutostartTick({ excludeWorkflowId: workflowId });
  if (plan.status === "skipped") return plan;

  let refreshed = false;
  if (plan.needRefresh) {
    await executeChild(potatoRefreshWorkflow, {
      workflowId: `potato-refresh-autostart-${runId}`,
      args: [],
    });
    refreshed = true;
  }

  return startAutostartSitespeed({
    job: plan.job,
    jobIndex: plan.jobIndex,
    refreshed,
    excludeWorkflowId: workflowId,
  });
}
