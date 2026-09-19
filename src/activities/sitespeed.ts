import { heartbeat, log } from "@temporalio/activity";
import { assertExportConfig, getEnv } from "../lib/env";
import { podman } from "../lib/podman";
import {
  buildGraphiteNamespace,
  buildResultSlug,
} from "../shared/graphite-ns";
import type { CacheMode } from "../shared/types";

/**
 * Closest built-in Chrome DevTools preset to Galaxy A05 (no A05 in the list).
 * A51/71: 412×914 CSS @ 2.625 dpr — mid-range Samsung phone class.
 * @see https://developer.chrome.com/docs/chromedriver/mobile-emulation
 */
export const CHROME_DEVICE_NAME = "Samsung Galaxy A51/71";

/** Mid-range phone CPU slowdown for desktop Chrome emulation. */
const CPU_THROTTLING_RATE = 4;

export type RunSitespeedInput = {
  potatoContainer: string;
  url: string;
  metricPrefix: string;
  browser: string;
  iterations: number;
  cacheMode: CacheMode;
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
    input.cacheMode,
    env.graphiteNamespaceBase,
  );
  const slug = buildResultSlug(input.metricPrefix, input.cacheMode);

  const cmd: string[] = [
    "-b",
    input.browser,
    "-n",
    String(input.iterations),
    "--slug",
    slug,
    // Mobile preset for Lighthouse / coach; override Chrome device to A51/71
    "--mobile",
    "--browsertime.chrome.mobileEmulation.deviceName",
    CHROME_DEVICE_NAME,
    "--browsertime.chrome.CPUThrottlingRate",
    String(CPU_THROTTLING_RATE),
    // PotatoNetwork shapes traffic — do not double-throttle in browsertime
    "-c",
    "native",
    "--browsertime.connectivity.engine",
    "external",
    // plus1 image also ships GPSI; skip external Google PSI
    "--plugins.remove",
    "@sitespeed.io/plugin-gpsi",
    "--browsertime.chrome.args",
    "ignore-certificate-errors",
    "--browsertime.chrome.args",
    "ignore-certificate-errors-spki-list",
  ];

  if (input.cacheMode === "warm") {
    // Same session: hit URL once to fill cache, then measure
    cmd.push("--preURL", input.url);
  } else {
    cmd.push("--browsertime.cacheClearRaw");
  }

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
    cacheMode: input.cacheMode,
    deviceName: CHROME_DEVICE_NAME,
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
