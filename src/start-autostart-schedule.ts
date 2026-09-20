import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
} from "@temporalio/client";
import { getEnv } from "./lib/env";
import { temporalConnectionOptions } from "./lib/temporal-connect";

const SCHEDULE_ID = "potato-sitespeed-autostart";

async function main(): Promise<void> {
  const env = getEnv();
  const connection = await Connection.connect(
    await temporalConnectionOptions(env),
  );
  const client = new Client({
    connection,
    namespace: env.temporalNamespace,
  });

  const spec = {
    intervals: [{ every: env.autostartScheduleInterval }],
  };
  const action = {
    type: "startWorkflow" as const,
    workflowType: "autostartWorkflow",
    taskQueue: env.temporalTaskQueue,
    args: [] as [],
  };

  const handle = client.schedule.getHandle(SCHEDULE_ID);
  try {
    await handle.update((prev) => ({
      ...prev,
      spec,
      action,
      state: { ...prev.state, paused: false },
    }));
    console.log(
      JSON.stringify({
        msg: "updated autostart schedule",
        scheduleId: SCHEDULE_ID,
        interval: env.autostartScheduleInterval,
        taskQueue: env.temporalTaskQueue,
        configPath: env.configPath,
        statePath: env.autostartStatePath,
      }),
    );
  } catch (err) {
    if (!(err instanceof ScheduleNotFoundError)) throw err;
    try {
      await client.schedule.create({
        scheduleId: SCHEDULE_ID,
        spec,
        action,
      });
      console.log(
        JSON.stringify({
          msg: "created autostart schedule",
          scheduleId: SCHEDULE_ID,
          interval: env.autostartScheduleInterval,
          taskQueue: env.temporalTaskQueue,
          configPath: env.configPath,
          statePath: env.autostartStatePath,
        }),
      );
    } catch (createErr) {
      if (createErr instanceof ScheduleAlreadyRunning) {
        console.log(
          JSON.stringify({
            msg: "autostart schedule already exists",
            scheduleId: SCHEDULE_ID,
          }),
        );
        return;
      }
      throw createErr;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
