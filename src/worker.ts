import { createRequire } from "node:module";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index";
import { getEnv } from "./lib/env";

const require = createRequire(import.meta.url);

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
      sitespeedMaxAttempts: env.sitespeedMaxAttempts,
      sitespeedResultsDir: env.sitespeedResultsDir,
      telegrafAddr: env.telegrafAddr ?? null,
      volume: env.potatoDataVolume,
      potatoRulesExpr: env.potatoRulesExpr ?? null,
      hostGateway: env.hostGateway ?? null,
    }),
  );

  const connection = await NativeConnection.connect({
    address: env.temporalAddress,
  });

  // Inject SITESPEED_MAX_ATTEMPTS into the workflow bundle as a string literal
  // so workflow code stays deterministic (no runtime process.env in the isolate).
  const webpack = require("webpack") as typeof import("webpack");

  const worker = await Worker.create({
    connection,
    namespace: env.temporalNamespace,
    taskQueue: env.temporalTaskQueue,
    workflowsPath: new URL("./workflows/index.ts", import.meta.url).pathname,
    activities,
    bundlerOptions: {
      webpackConfigHook: (config) => {
        config.plugins = [
          ...(config.plugins ?? []),
          new webpack.DefinePlugin({
            "process.env.SITESPEED_MAX_ATTEMPTS": JSON.stringify(
              String(env.sitespeedMaxAttempts),
            ),
          }),
        ];
        return config;
      },
    },
  });

  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
