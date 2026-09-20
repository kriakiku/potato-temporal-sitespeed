import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { log } from "@temporalio/activity";
import {
  clampAutostartIndex,
  loadPotatoConfig,
  parseAutostartState,
  type AutostartState,
} from "../lib/autostart-jobs";
import { getEnv } from "../lib/env";
import { temporalConnectionOptions } from "../lib/temporal-connect";
import type { SiteSpeedTestInput, AutostartTickResult } from "../shared/types";

export type { AutostartTickResult };

export type AutostartPlanSkipped = {
  status: "skipped";
  reason: "busy" | "no_jobs" | "missing_jobs_file";
  busyWorkflowIds?: string[];
};

export type AutostartPlanReady = {
  status: "ready";
  job: SiteSpeedTestInput;
  jobIndex: number;
  needRefresh: boolean;
};

export type AutostartPlanResult = AutostartPlanSkipped | AutostartPlanReady;

export type StartAutostartSitespeedInput = {
  job: SiteSpeedTestInput;
  jobIndex: number;
  refreshed: boolean;
  excludeWorkflowId: string;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readState(path: string): Promise<AutostartState> {
  if (!(await fileExists(path))) return { nextIndex: 0 };
  try {
    const text = await readFile(path, "utf8");
    return parseAutostartState(JSON.parse(text) as unknown);
  } catch {
    return { nextIndex: 0 };
  }
}

async function writeState(path: string, state: AutostartState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const env = getEnv();
  const connection = await Connection.connect(
    await temporalConnectionOptions(env),
  );
  const client = new Client({
    connection,
    namespace: env.temporalNamespace,
  });
  try {
    return await fn(client);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function listBusyWorkflowIds(
  client: Client,
  taskQueue: string,
  excludeWorkflowId?: string,
): Promise<string[]> {
  const query = `ExecutionStatus = "Running" and TaskQueue = "${taskQueue}"`;
  const busy: string[] = [];
  const consider = (workflowId: string, typeName: string) => {
    if (excludeWorkflowId && workflowId === excludeWorkflowId) return;
    void typeName;
    busy.push(workflowId);
  };
  try {
    for await (const wf of client.workflow.list({ query })) {
      consider(wf.workflowId, wf.type);
    }
  } catch (err) {
    log.warn("autostart busy query with TaskQueue failed; retrying without", {
      err: err instanceof Error ? err.message : String(err),
    });
    for await (const wf of client.workflow.list({
      query: `ExecutionStatus = "Running"`,
    })) {
      const tq = (wf as { taskQueue?: string }).taskQueue;
      if (tq && tq !== taskQueue) continue;
      consider(wf.workflowId, wf.type);
    }
  }
  return busy;
}

async function jobsOrSkip(
  path: string,
): Promise<
  | { ok: true; jobs: SiteSpeedTestInput[] }
  | { ok: false; result: AutostartPlanSkipped }
> {
  let loaded;
  try {
    loaded = await loadPotatoConfig(path);
  } catch (err) {
    log.warn("autostart config file invalid", {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, result: { status: "skipped", reason: "no_jobs" } };
  }

  if (loaded === null) {
    log.info("autostart skipped: config file missing", { path });
    return {
      ok: false,
      result: { status: "skipped", reason: "missing_jobs_file" },
    };
  }

  if (loaded.reloaded) {
    log.info("potato config hot-reloaded", {
      path: loaded.path,
      mtimeMs: loaded.mtimeMs,
      autostartCount: loaded.jobs.length,
    });
  }

  if (loaded.jobs.length === 0) {
    log.info("autostart skipped: empty jobs list");
    return { ok: false, result: { status: "skipped", reason: "no_jobs" } };
  }

  return { ok: true, jobs: loaded.jobs };
}

/**
 * Decide whether to start a job this tick (no workflow starts here).
 * Refresh must run as a child workflow so we do not hold the activity slot.
 * Jobs JSON is hot-reloaded when the file mtime changes (no worker restart).
 */
export async function planAutostartTick(input: {
  excludeWorkflowId: string;
}): Promise<AutostartPlanResult> {
  const env = getEnv();
  return withClient(async (client) => {
    const busy = await listBusyWorkflowIds(
      client,
      env.temporalTaskQueue,
      input.excludeWorkflowId,
    );
    if (busy.length > 0) {
      log.info("autostart skipped: task queue busy", { busy });
      return { status: "skipped", reason: "busy", busyWorkflowIds: busy };
    }

    const loaded = await jobsOrSkip(env.configPath);
    if (!loaded.ok) return loaded.result;

    const state = await readState(env.autostartStatePath);
    const jobIndex = clampAutostartIndex(state.nextIndex, loaded.jobs.length);
    const job = loaded.jobs[jobIndex]!;

    return {
      status: "ready",
      job,
      jobIndex,
      needRefresh: jobIndex === 0,
    };
  });
}

/**
 * Re-check busy, start siteSpeedTestWorkflow, advance round-robin index.
 * Re-reads jobs so a JSON edit between plan and start is picked up.
 */
export async function startAutostartSitespeed(
  input: StartAutostartSitespeedInput,
): Promise<AutostartTickResult> {
  const env = getEnv();
  return withClient(async (client) => {
    const busy = await listBusyWorkflowIds(
      client,
      env.temporalTaskQueue,
      input.excludeWorkflowId,
    );
    if (busy.length > 0) {
      log.info("autostart skipped at commit: task queue busy", { busy });
      return { status: "skipped", reason: "busy", busyWorkflowIds: busy };
    }

    const loaded = await jobsOrSkip(env.configPath);
    if (!loaded.ok) {
      return {
        status: "skipped",
        reason:
          loaded.result.reason === "missing_jobs_file"
            ? "no_jobs"
            : loaded.result.reason,
      };
    }

    const jobIndex = clampAutostartIndex(input.jobIndex, loaded.jobs.length);
    const job = loaded.jobs[jobIndex] ?? input.job;

    const ts = Date.now();
    const metricPrefix = job.metricPrefix;
    const workflowId = `sitespeed-autostart-${metricPrefix}-${ts}`;
    await client.workflow.start("siteSpeedTestWorkflow", {
      taskQueue: env.temporalTaskQueue,
      workflowId,
      args: [job],
    });

    const nextIndex = (jobIndex + 1) % loaded.jobs.length;
    await writeState(env.autostartStatePath, { nextIndex });

    log.info("autostart started sitespeed", {
      workflowId,
      jobIndex,
      nextIndex,
      refreshed: input.refreshed,
      metricPrefix,
    });

    return {
      status: "started",
      workflowId,
      jobIndex,
      nextIndex,
      refreshed: input.refreshed,
      metricPrefix,
    };
  });
}
