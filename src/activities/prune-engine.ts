import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { heartbeat, log } from "@temporalio/activity";
import { getEnv } from "../lib/env";
import { podman } from "../lib/podman";

export type PruneEngineResourcesResult = {
  removedContainers: string[];
  removedVolumes: string[];
  prunedContainers: unknown;
  prunedNetworks: unknown;
  prunedImages: unknown;
  prunedBuilder: unknown;
  removedResultDirs: string[];
};

/** How many newest sitespeed run directories to keep under SITESPEED_RESULTS_DIR. */
const KEEP_NEWEST_RESULT_DIRS = 20;

/**
 * Disk reclaim for potatoRefreshWorkflow: tear down leftover sitespeed/potato
 * containers, prune unused networks/volumes (except the Potato data volume),
 * dangling images + build cache, and old local result dirs.
 * Does **not** pull images.
 */
export async function pruneEngineResources(): Promise<PruneEngineResourcesResult> {
  const env = getEnv();
  heartbeat({ step: "prune-engine" });

  const engine = await podman.pruneStaleResources({
    containerNamePrefixes: ["potato-", "sitespeed-"],
    keepVolumes: [env.potatoDataVolume],
  });

  const removedResultDirs = await pruneOldResultDirs(
    env.sitespeedResultsDir,
    KEEP_NEWEST_RESULT_DIRS,
  );

  const result: PruneEngineResourcesResult = {
    ...engine,
    removedResultDirs,
  };
  log.info("Pruned engine resources", {
    removedContainers: result.removedContainers.length,
    removedVolumes: result.removedVolumes.length,
    removedResultDirs: result.removedResultDirs.length,
  });
  return result;
}

async function pruneOldResultDirs(
  resultsDir: string,
  keepNewest: number,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(resultsDir);
  } catch {
    return [];
  }

  const dirs: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    // Keep autostart jobs/state files and non-dirs.
    if (name.startsWith("autostart-") || name.startsWith(".")) continue;
    const full = join(resultsDir, name);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      dirs.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }

  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = dirs.slice(keepNewest);
  const removed: string[] = [];
  for (const d of toRemove) {
    const full = join(resultsDir, d.name);
    try {
      await rm(full, { recursive: true, force: true });
      removed.push(d.name);
    } catch (err) {
      log.warn("Failed to remove old results dir", {
        dir: full,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return removed;
}
