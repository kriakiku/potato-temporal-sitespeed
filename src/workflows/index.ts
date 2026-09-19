import {
  CancellationScope,
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
} from "../shared/types";

const {
  ensurePotatoVolume,
  startPotato,
  waitPotatoHealthy,
  stopPotato,
  refreshPotatoCatalog,
  refreshPotatoBaseline,
  resolveEntryUrl,
  pullUsedImages,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
  },
});

const { runSitespeed } = proxyActivities<typeof activities>({
  startToCloseTimeout: "90 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    // Default 1 — no retries on sitespeed.io (SITESPEED_MAX_ATTEMPTS).
    maximumAttempts: sitespeedActivityMaxAttempts(),
    initialInterval: "10s",
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

  await ensurePotatoVolume();

  const potato = await startPotato({
    runId,
    country: normalized.country,
    tier: normalized.tier,
    namePrefix: "potato-ss",
  });

  try {
    await waitPotatoHealthy(potato);

    const result = await runSitespeed({
      potatoContainer: potato.containerName,
      url: entry.frameUrl,
      metricPrefix: normalized.metricPrefix,
      country: normalized.country,
      tier: normalized.tier,
      tld: normalized.tld,
      browser: normalized.browser,
      iterations: normalized.iterations,
      cacheMode: normalized.cacheMode,
      direct: normalized.direct,
    });

    return {
      url: entry.frameUrl,
      msid: entry.msid,
      mode: entry.mode,
      metricPrefix: normalized.metricPrefix,
      cacheMode: normalized.cacheMode,
      direct: normalized.direct,
      isMirror: result.isMirror,
      graphiteNamespace: result.graphiteNamespace,
      potatoContainer: potato.containerName,
      sitespeedExitCode: result.exitCode,
    };
  } finally {
    // Always tear down Potato even when the workflow is cancelled mid-run.
    await CancellationScope.nonCancellable(async () => {
      await stopPotato(potato);
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
