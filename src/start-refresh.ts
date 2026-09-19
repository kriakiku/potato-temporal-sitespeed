import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { getEnv } from "./lib/env";

async function main(): Promise<void> {
  const env = getEnv();
  const connection = await Connection.connect({ address: env.temporalAddress });
  const client = new Client({
    connection,
    namespace: env.temporalNamespace,
  });

  const workflowId = "potato-refresh";

  try {
    const handle = await client.workflow.start("potatoRefreshWorkflow", {
      taskQueue: env.temporalTaskQueue,
      workflowId,
      args: [],
    });
    console.log(`Started workflow ${handle.workflowId}`);
    const result = await handle.result();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      console.error(
        `Workflow ${workflowId} is already running; wait for it to finish or terminate it.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
