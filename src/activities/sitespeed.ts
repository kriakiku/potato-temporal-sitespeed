import { heartbeat, log } from "@temporalio/activity";
import { assertExportConfig, getEnv } from "../lib/env";
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

  const sitespeedArgs: string[] = [
    "-b",
    input.browser,
    "-n",
    String(input.iterations),
    "--slug",
    slug,
    // Trust PotatoNetwork MITM CA (Chrome + Node)
    "--browsertime.chrome.args",
    "ignore-certificate-errors",
    "--browsertime.chrome.args",
    "ignore-certificate-errors-spki-list",
  ];

  if (env.graphiteHost) {
    sitespeedArgs.push("--graphite.host", env.graphiteHost);
    sitespeedArgs.push("--graphite.port", env.graphitePort);
    sitespeedArgs.push("--graphite.namespace", graphiteNamespace);
    sitespeedArgs.push("--graphite.addSlugToKey", "true");
    if (env.graphiteAuth) {
      sitespeedArgs.push("--graphite.auth", env.graphiteAuth);
    }
  }

  if (env.s3Bucket && env.s3Key && env.s3Secret) {
    sitespeedArgs.push("--s3.bucketname", env.s3Bucket);
    sitespeedArgs.push("--s3.key", env.s3Key);
    sitespeedArgs.push("--s3.secret", env.s3Secret);
    if (env.s3Endpoint) sitespeedArgs.push("--s3.endpoint", env.s3Endpoint);
    if (env.s3Region) sitespeedArgs.push("--s3.region", env.s3Region);
    if (env.s3ResultBaseUrl) {
      sitespeedArgs.push("--resultBaseURL", env.s3ResultBaseUrl);
    }
    sitespeedArgs.push("--s3.removeLocalResult", "true");
  }

  sitespeedArgs.push(input.url);

  const podmanArgs = [
    "run",
    "--rm",
    "--shm-size",
    "2g",
    "--network",
    `container:${input.potatoContainer}`,
    "-v",
    `${env.potatoDataVolume}:/potato-data:ro`,
    "-e",
    "NODE_EXTRA_CA_CERTS=/potato-data/ca/potatonetwork-ca.pem",
    "-e",
    "SSL_CERT_FILE=/potato-data/ca/potatonetwork-ca.pem",
    env.sitespeedImage,
    ...sitespeedArgs,
  ];

  log.info("Starting sitespeed.io", {
    potatoContainer: input.potatoContainer,
    url: input.url,
    graphiteNamespace,
    slug,
  });

  heartbeat({ step: "sitespeed-start" });

  // Long-running: stream and heartbeat while waiting
  const proc = Bun.spawn(["podman", ...podmanArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const readSide = async (
    stream: ReadableStream<Uint8Array> | null,
    chunks: string[],
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
      heartbeat({ step: "sitespeed-running", bytes: value.byteLength });
    }
  };

  await Promise.all([
    readSide(proc.stdout, stdoutChunks),
    readSide(proc.stderr, stderrChunks),
  ]);

  const exitCode = (await proc.exited) ?? 1;
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

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
