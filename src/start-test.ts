import { Client, Connection } from "@temporalio/client";
import { getEnv } from "./lib/env";
import type { SiteSpeedTestInput } from "./shared/types";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const env = getEnv();

  const metricPrefix = arg("metricPrefix");
  const country = arg("country");
  const tld = arg("tld");
  if (!metricPrefix || !country || !tld) {
    console.error(
      "Usage: bun run src/start-test.ts --metricPrefix lobby --country BD --tld example.com [--tableId ID] [--direct] [--tier typical] [--cacheMode cold|warm]",
    );
    process.exit(1);
  }

  const input: SiteSpeedTestInput = {
    metricPrefix,
    country,
    tld,
    tableId: arg("tableId"),
    direct: flag("direct") ? true : arg("tableId") ? false : undefined,
    tier: (arg("tier") as SiteSpeedTestInput["tier"]) ?? undefined,
    browser: arg("browser"),
    iterations: arg("iterations") ? Number(arg("iterations")) : undefined,
    cacheMode: (arg("cacheMode") as SiteSpeedTestInput["cacheMode"]) ?? undefined,
  };

  const connection = await Connection.connect({ address: env.temporalAddress });
  const client = new Client({
    connection,
    namespace: env.temporalNamespace,
  });

  const handle = await client.workflow.start("siteSpeedTestWorkflow", {
    taskQueue: env.temporalTaskQueue,
    workflowId: `sitespeed-${input.metricPrefix}-${Date.now()}`,
    args: [input],
  });

  console.log(`Started workflow ${handle.workflowId}`);
  const result = await handle.result();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
