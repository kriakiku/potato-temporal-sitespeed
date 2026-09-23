/**
 * The Temporal Rust core can lose its gRPC session (http2 keepalive timeout)
 * and keep the process alive without polling. systemd only restarts on exit,
 * so a stuck poller has to end the process itself.
 */

export type WorkerPollSnapshot = {
  runState: string;
  workflowPollerState: string;
  activityPollerState: string;
  hasOutstandingWorkflowPoll: boolean;
  numInFlightWorkflowActivations: number;
};

export type PollStall = {
  reason: "poller-failed" | "workflow-poll-stalled";
  sinceMs: number;
};

/** How long a dead poll may last before the process exits. */
export const POLL_STALL_MS = 90_000;

export function observePollHealth(
  prev: PollStall | null,
  status: WorkerPollSnapshot,
  nowMs: number,
): PollStall | null {
  if (status.runState !== "RUNNING") return null;

  const reason: PollStall["reason"] | null =
    status.workflowPollerState === "FAILED" ||
    status.activityPollerState === "FAILED"
      ? "poller-failed"
      : !status.hasOutstandingWorkflowPoll &&
          status.numInFlightWorkflowActivations === 0
        ? "workflow-poll-stalled"
        : null;

  if (!reason) return null;
  if (prev?.reason === reason) return prev;
  return { reason, sinceMs: nowMs };
}

export function stallExceeded(
  stall: PollStall | null,
  nowMs: number,
  stallMs: number,
): boolean {
  if (!stall) return false;
  return nowMs - stall.sinceMs >= stallMs;
}

export function startPollWatch(
  getStatus: () => WorkerPollSnapshot,
  options: {
    intervalMs?: number;
    stallMs?: number;
    now?: () => number;
    exit?: (code: number) => void;
    log?: (record: Record<string, unknown>) => void;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 15_000;
  const stallMs = options.stallMs ?? POLL_STALL_MS;
  const now = options.now ?? Date.now;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log =
    options.log ??
    ((record: Record<string, unknown>) => {
      console.error(JSON.stringify(record));
    });

  let stall: PollStall | null = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    let status: WorkerPollSnapshot;
    try {
      status = getStatus();
    } catch (err) {
      log({
        msg: "temporal worker poll check failed",
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    stall = observePollHealth(stall, status, now());
    if (!stallExceeded(stall, now(), stallMs)) return;
    stopped = true;
    clearInterval(timer);
    log({
      msg: "temporal worker poll stalled; exiting for restart",
      reason: stall?.reason,
      stalledForMs: stall ? now() - stall.sinceMs : 0,
      runState: status.runState,
      workflowPollerState: status.workflowPollerState,
      activityPollerState: status.activityPollerState,
      hasOutstandingWorkflowPoll: status.hasOutstandingWorkflowPoll,
    });
    exit(1);
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
