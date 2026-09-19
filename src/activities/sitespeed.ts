import { heartbeat, log } from "@temporalio/activity";
import { assertExportConfig, getEnv } from "../lib/env";
import { podman } from "../lib/podman";
import {
  buildGraphiteNamespace,
  buildResultSlug,
} from "../shared/graphite-ns";

export type RunSitespeedInput = {
  potatoContainer: string;
  url: string;
  metricPrefix: string;
  browser: string;
  iterations: number;
};

export type RunSitespeedResult = {
  exitCode: number;
  graphiteNamespace: string;
  slug: string;
  stdoutTail: string;
  stderrTail: string;
};

function tail(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return text.slice(-max);
}

export async function runSitespeed(
  input: RunSitespeedInput,
): Promise<RunSitespeedResult> {
  const env = getEnv();
  assertExportConfig(env);

  const graphiteNamespace = buildGraphiteNamespace(
    input.metricPrefix,
    env.graphiteNamespaceBase,
  );
  const slug = buildResultSlug(input.metricPrefix);

  const cmd: string[] = [
    "-b",
    input.browser,
    "-n",
    String(input.iterations),
    "--slug",
    slug,
    "--browsertime.chrome.args",
    "ignore-certificate-errors",
    "--browsertime.chrome.args",
    "ignore-certificate-errors-spki-list",
  ];

  if (env.graphiteHost) {
    cmd.push("--graphite.host", env.graphiteHost);
    cmd.push("--graphite.port", env.graphitePort);
    cmd.push("--graphite.namespace", graphiteNamespace);
    cmd.push("--graphite.addSlugToKey", "true");
    if (env.graphiteAuth) {
      cmd.push("--graphite.auth", env.graphiteAuth);
    }
  }

  if (env.s3Bucket && env.s3Key && env.s3Secret) {
    cmd.push("--s3.bucketname", env.s3Bucket);
    cmd.push("--s3.key", env.s3Key);
    cmd.push("--s3.secret", env.s3Secret);
    if (env.s3Endpoint) cmd.push("--s3.endpoint", env.s3Endpoint);
    if (env.s3Region) cmd.push("--s3.region", env.s3Region);
    if (env.s3ResultBaseUrl) {
      cmd.push("--resultBaseURL", env.s3ResultBaseUrl);
    }
    cmd.push("--s3.removeLocalResult", "true");
  }

  cmd.push(input.url);

  const containerName = `sitespeed-${slug}-${Date.now()}`;

  log.info("Starting sitespeed.io", {
    potatoContainer: input.potatoContainer,
    url: input.url,
    graphiteNamespace,
    slug,
  });

  heartbeat({ step: "sitespeed-start" });

  const { exitCode, stdout, stderr } = await podman.runToCompletion(
    {
      name: containerName,
      image: env.sitespeedImage,
      cmd,
      networkMode: `container:${input.potatoContainer}`,
      binds: [`${env.potatoDataVolume}:/potato-data:ro`],
      env: {
        NODE_EXTRA_CA_CERTS: "/potato-data/ca/potatonetwork-ca.pem",
        SSL_CERT_FILE: "/potato-data/ca/potatonetwork-ca.pem",
      },
      shmSizeBytes: 2 * 1024 * 1024 * 1024,
    },
    () => heartbeat({ step: "sitespeed-running" }),
  );

  if (exitCode !== 0) {
    throw new Error(
      `sitespeed.io exited with code ${exitCode}\n${tail(stderr) || tail(stdout)}`,
    );
  }

  return {
    exitCode,
    graphiteNamespace,
    slug,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}
