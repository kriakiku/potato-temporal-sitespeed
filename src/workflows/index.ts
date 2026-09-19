import {
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities/index";
import { normalizeSiteSpeedInput } from "../shared/entry-url";
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
    maximumAttempts: 2,
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
      browser: normalized.browser,
      iterations: normalized.iterations,
      cacheMode: normalized.cacheMode,
    });

    return {
      url: entry.frameUrl,
      msid: entry.msid,
      mode: entry.mode,
      metricPrefix: normalized.metricPrefix,
      cacheMode: normalized.cacheMode,
      graphiteNamespace: result.graphiteNamespace,
      potatoContainer: potato.containerName,
      sitespeedExitCode: result.exitCode,
    };
  } finally {
    await stopPotato(potato);
  }
}

/** Stable workflow id recommended: "potato-refresh" */
export async function potatoRefreshWorkflow(): Promise<PotatoRefreshResult> {
  const { runId } = workflowInfo();

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
    };
  } finally {
    await stopPotato(potato);
  }
}
