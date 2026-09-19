import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index";
import { getEnv } from "./lib/env";

async function main(): Promise<void> {
  const env = getEnv();

  console.log(
    JSON.stringify({
      msg: "starting sitespeed temporal worker",
      address: env.temporalAddress,
      namespace: env.temporalNamespace,
      taskQueue: env.temporalTaskQueue,
      potatoImage: env.potatoImage,
      sitespeedImage: env.sitespeedImage,
      volume: env.potatoDataVolume,
      potatoRulesExpr: env.potatoRulesExpr ?? null,
      hostGateway: env.hostGateway ?? null,
    }),
  );

  const connection = await NativeConnection.connect({
    address: env.temporalAddress,
  });

  const worker = await Worker.create({
    connection,
    namespace: env.temporalNamespace,
    taskQueue: env.temporalTaskQueue,
    workflowsPath: new URL("./workflows/index.ts", import.meta.url).pathname,
    activities,
  });

  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
