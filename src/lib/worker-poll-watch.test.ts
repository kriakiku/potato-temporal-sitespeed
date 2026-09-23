import { describe, expect, test } from "bun:test";
import {
  observePollHealth,
  stallExceeded,
  startPollWatch,
  type WorkerPollSnapshot,
} from "./worker-poll-watch";

const healthy: WorkerPollSnapshot = {
  runState: "RUNNING",
  workflowPollerState: "POLLING",
  activityPollerState: "POLLING",
  hasOutstandingWorkflowPoll: true,
  numInFlightWorkflowActivations: 0,
};

describe("observePollHealth", () => {
  test("ignores a worker that is not running", () => {
    expect(
      observePollHealth(null, { ...healthy, runState: "INITIALIZED" }, 1_000),
    ).toBeNull();
  });

  test("ignores a healthy outstanding workflow poll", () => {
    expect(observePollHealth(null, healthy, 1_000)).toBeNull();
  });

  test("ignores a busy workflow activation without an outstanding poll", () => {
    expect(
      observePollHealth(
        null,
        {
          ...healthy,
          hasOutstandingWorkflowPoll: false,
          numInFlightWorkflowActivations: 1,
        },
        1_000,
      ),
    ).toBeNull();
  });

  test("starts a stall when the workflow poll disappears", () => {
    const stall = observePollHealth(
      null,
      { ...healthy, hasOutstandingWorkflowPoll: false },
      5_000,
    );
    expect(stall).toEqual({ reason: "workflow-poll-stalled", sinceMs: 5_000 });
  });

  test("keeps the original stall timestamp while the poll stays down", () => {
    const first = observePollHealth(
      null,
      { ...healthy, hasOutstandingWorkflowPoll: false },
      5_000,
    );
    const second = observePollHealth(
      first,
      { ...healthy, hasOutstandingWorkflowPoll: false },
      50_000,
    );
    expect(second).toEqual(first);
  });

  test("clears the stall when polling resumes", () => {
    const stall = observePollHealth(
      null,
      { ...healthy, hasOutstandingWorkflowPoll: false },
      5_000,
    );
    expect(observePollHealth(stall, healthy, 6_000)).toBeNull();
  });

  test("records a failed poller", () => {
    expect(
      observePollHealth(
        null,
        { ...healthy, workflowPollerState: "FAILED" },
        2_000,
      ),
    ).toEqual({ reason: "poller-failed", sinceMs: 2_000 });
  });
});

describe("stallExceeded", () => {
  test("is false until the window elapses", () => {
    const stall = { reason: "workflow-poll-stalled" as const, sinceMs: 0 };
    expect(stallExceeded(stall, 89_999, 90_000)).toBe(false);
    expect(stallExceeded(stall, 90_000, 90_000)).toBe(true);
    expect(stallExceeded(null, 90_000, 90_000)).toBe(false);
  });
});

describe("startPollWatch", () => {
  test("exits once the stall window elapses", async () => {
    const logs: Record<string, unknown>[] = [];
    let code: number | undefined;
    const stop = startPollWatch(
      () => ({ ...healthy, hasOutstandingWorkflowPoll: false }),
      {
        intervalMs: 20,
        stallMs: 45,
        exit: (c) => {
          code = c;
        },
        log: (record) => logs.push(record),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    expect(code).toBe(1);
    expect(logs[0]?.reason).toBe("workflow-poll-stalled");
  });

  test("does not exit while polls stay outstanding", async () => {
    let code: number | undefined;
    const stop = startPollWatch(() => healthy, {
      intervalMs: 20,
      stallMs: 40,
      exit: (c) => {
        code = c;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    expect(code).toBeUndefined();
  });
});
