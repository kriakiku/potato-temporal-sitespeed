import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index";
import { getEnv } from "./lib/env";
import {
  temporalConnectionOptions,
  temporalTlsLogFlags,
} from "./lib/temporal-connect";
import { startPollWatch } from "./lib/worker-poll-watch";

async function main(): Promise<void> {
  const env = getEnv();
  const tlsFlags = temporalTlsLogFlags(env);

  console.log(
    JSON.stringify({
      msg: "starting sitespeed temporal worker",
      address: env.temporalAddress,
      namespace: env.temporalNamespace,
      taskQueue: env.temporalTaskQueue,
      maxConcurrentActivities: env.maxConcurrentActivities,
      temporalTls: tlsFlags.temporalTls,
      temporalTlsClientCert: tlsFlags.temporalTlsClientCert,
      temporalTlsCa: tlsFlags.temporalTlsCa,
      potatoImage: env.potatoImage,
      sitespeedImage: env.sitespeedImage,
      sitespeedResultsDir: env.sitespeedResultsDir,
      influxWriteUrl: env.influxWriteUrl ?? null,
      volume: env.potatoDataVolume,
      potatoRulesExpr: env.potatoRulesExpr ?? null,
      hostGateway: env.hostGateway ?? null,
    }),
  );

  const connection = await NativeConnection.connect(
    await temporalConnectionOptions(env),
  );

  const worker = await Worker.create({
    connection,
    namespace: env.temporalNamespace,
    taskQueue: env.temporalTaskQueue,
    workflowsPath: new URL("./workflows/index.ts", import.meta.url).pathname,
    activities,
    maxConcurrentActivityTaskExecutions: env.maxConcurrentActivities,
    maxConcurrentLocalActivityExecutions: env.maxConcurrentActivities,
  });

  // Exit if the gRPC session dies but the process stays up, so Restart=always
  // brings a worker that actually polls back.
  startPollWatch(() => worker.getStatus());

  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
