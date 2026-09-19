import { heartbeat, log } from "@temporalio/activity";
import { assertExportConfig, getEnv } from "../lib/env";
import {
  resolveEndpointForPotatoNetns,
  resolveHostForPotatoNetns,
} from "../lib/host-gateway";
import { promoteSitespeedLatestToNamespace } from "../lib/s3-latest";
import { podman } from "../lib/podman";
import {
  buildGraphiteNamespace,
  buildResultSlug,
  resolveIsMirror,
} from "../shared/graphite-ns";
import {
  buildSitespeedBrowserArgs,
  CHROME_DEVICE_NAME,
} from "../shared/sitespeed-args";
import { sitespeedPotatoEntrypoint } from "../shared/sitespeed-entrypoint";
import type { CacheMode, PotatoTier } from "../shared/types";

export { CHROME_DEVICE_NAME } from "../shared/sitespeed-args";

export type RunSitespeedInput = {
  potatoContainer: string;
  url: string;
  metricPrefix: string;
  country: string;
  tier: PotatoTier;
  /** Workflow tld — compared to BASE_TLD for isMirror */
  tld: string;
  browser: string;
  iterations: number;
  cacheMode: CacheMode;
};

export type RunSitespeedResult = {
  exitCode: number;
  graphiteNamespace: string;
  slug: string;
  isMirror: boolean;
  stdoutTail: string;
  stderrTail: string;
};

function tail(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return text.slice(-max);
}

/** Temporal rejects oversized activity failures; keep messages small. */
const FAILURE_MESSAGE_MAX = 1500;

/**
 * sitespeed Graphite plugin throws when lighthouse.pageSummary has only null
 * category scores (common for SPAs / MITM). That fails the whole process even
 * if Browsertime + S3 succeeded. Treat that as a soft warning.
 */
export function isLighthouseGraphiteEmptyDataFailure(text: string): boolean {
  if (!text.includes("No data to send to graphite for message")) return false;
  if (!text.includes("lighthouse.pageSummary")) return false;

  const errorHeads = [...text.matchAll(/\] ERROR:\s*(.+)/g)].map((m) =>
    m[1].trim(),
  );
  if (errorHeads.length === 0) return false;

  return errorHeads.every(
    (line) =>
      line.startsWith("Error: No data to send to graphite for message:") ||
      line.startsWith("No data to send to graphite for message:"),
  );
}

/**
 * Compact stderr/stdout into a Temporal-safe failure message.
 * Prefer UrlLoadError / ERROR lines; drop huge JSON blobs (Lighthouse payloads).
 */
export function summarizeSitespeedFailure(
  exitCode: number,
  combined: string,
): string {
  const lines = combined.split(/\r?\n/);
  const picked: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /UrlLoadError/i.test(trimmed) ||
      /\] ERROR:/.test(trimmed) ||
      /chrome-error:\/\//i.test(trimmed) ||
      /is the web page down/i.test(trimmed) ||
      /Failed to load /i.test(trimmed)
    ) {
      // Skip multi-line JSON bodies that follow graphite "No data" errors
      if (trimmed === "{" || trimmed.startsWith('"uuid"')) continue;
      picked.push(trimmed.slice(0, 400));
      if (picked.length >= 12) break;
    }
  }

  const body =
    picked.length > 0
      ? picked.join("\n")
      : tail(combined.replace(/\s+/g, " ").trim(), 800);

  const msg = `sitespeed.io exited with code ${exitCode}\n${body}`;
  if (msg.length <= FAILURE_MESSAGE_MAX) return msg;
  return `${msg.slice(0, FAILURE_MESSAGE_MAX - 1)}…`;
}

/**
 * Install Potato MITM CA into the sitespeed image trust stores (best-effort),
 * then exec the image ENTRYPOINT (/start.sh), which runs sitespeed.js.
 *
 * The plus1 image has no `sitespeed.io` on PATH — Docker ENTRYPOINT is /start.sh.
 */
function sitespeedEntrypointCmd(args: string[]): {
  entrypoint: string[];
  cmd: string[];
} {
  return sitespeedPotatoEntrypoint(args);
}

export async function runSitespeed(
  input: RunSitespeedInput,
): Promise<RunSitespeedResult> {
  const env = getEnv();
  assertExportConfig(env);

  const isMirror = resolveIsMirror(input.tld, env.baseTld);
  const dims = {
    metricPrefix: input.metricPrefix,
    country: input.country,
    tier: input.tier,
    cacheMode: input.cacheMode,
    isMirror,
    base: env.graphiteNamespaceBase,
  };
  const graphiteNamespace = buildGraphiteNamespace(dims);
  const slug = buildResultSlug(dims);

  const cmd = buildSitespeedBrowserArgs({
    browser: input.browser,
    iterations: input.iterations,
    slug,
    metricPrefix: input.metricPrefix,
    cacheMode: input.cacheMode,
    url: input.url,
    removeLighthouse: !env.sitespeedLighthouse,
    removeGpsi: true,
  });

  // Strip trailing URL so we can insert Graphite/S3 flags before it
  const measuredUrl = cmd.pop()!;

  if (env.graphiteHost) {
    const graphiteHost = await resolveHostForPotatoNetns(env.graphiteHost);
    if (graphiteHost !== env.graphiteHost) {
      log.info("Rewrote loopback GRAPHITE_HOST for potato netns", {
        from: env.graphiteHost,
        to: graphiteHost,
      });
    }
    cmd.push("--graphite.host", graphiteHost);
    cmd.push("--graphite.port", env.graphitePort);
    cmd.push("--graphite.namespace", graphiteNamespace);
    // Dimensions already live in the namespace; omit redundant slug segment
    cmd.push("--graphite.addSlugToKey", "false");
    if (env.graphiteAuth) {
      cmd.push("--graphite.auth", env.graphiteAuth);
    }
  }

  if (env.s3Bucket && env.s3Key && env.s3Secret) {
    cmd.push("--s3.bucketname", env.s3Bucket);
    cmd.push("--s3.key", env.s3Key);
    cmd.push("--s3.secret", env.s3Secret);
    // sitespeed S3 plugin requires region (us-east-1 is fine for MinIO/custom)
    cmd.push("--s3.region", env.s3Region || "us-east-1");
    if (env.s3Endpoint) {
      cmd.push(
        "--s3.endpoint",
        await resolveEndpointForPotatoNetns(env.s3Endpoint),
      );
    }
    if (env.s3ForcePathStyle) {
      cmd.push("--s3.options.forcePathStyle", "true");
    }
    if (env.s3ResultBaseUrl) {
      cmd.push(
        "--resultBaseURL",
        await resolveEndpointForPotatoNetns(env.s3ResultBaseUrl),
      );
    }
    // Do not use copyLatestFilesToBase — worker promotes clean files after upload
    cmd.push("--s3.removeLocalResult", "true");
  }

  cmd.push(measuredUrl);

  const containerName = `sitespeed-${slug}-${Date.now()}`;

  log.info("Starting sitespeed.io", {
    potatoContainer: input.potatoContainer,
    url: input.url,
    graphiteNamespace,
    slug,
    cacheMode: input.cacheMode,
    country: input.country,
    tier: input.tier,
    isMirror,
    tld: input.tld,
    deviceName: CHROME_DEVICE_NAME,
  });

  heartbeat({ step: "sitespeed-start" });

  const { entrypoint, cmd: wrappedCmd } = sitespeedEntrypointCmd(cmd);

  const { exitCode, stdout, stderr } = await podman.runToCompletion(
    {
      name: containerName,
      image: env.sitespeedImage,
      entrypoint,
      cmd: wrappedCmd,
      networkMode: `container:${input.potatoContainer}`,
      binds: [`${env.potatoDataVolume}:/potato-data:ro`],
      env: {
        // Append Potato CA — do NOT set SSL_CERT_FILE (that replaces the
        // whole trust store and breaks public CA verification).
        NODE_EXTRA_CA_CERTS: "/potato-data/ca/potatonetwork-ca.pem",
      },
      shmSizeBytes: 2 * 1024 * 1024 * 1024,
    },
    () => heartbeat({ step: "sitespeed-running" }),
  );

  const combined = `${stderr}\n${stdout}`;
  const softOk = isLighthouseGraphiteEmptyDataFailure(combined);

  if (exitCode !== 0 && !softOk) {
    throw new Error(summarizeSitespeedFailure(exitCode, combined));
  }

  if (softOk && exitCode !== 0) {
    log.warn(
      "sitespeed exited non-zero due to empty Lighthouse→Graphite payload; treating as success (Browsertime/S3 may still have completed)",
      { exitCode, slug },
    );
  }

  if (env.s3Bucket && env.s3Key && env.s3Secret) {
    heartbeat({ step: "s3-promote-latest" });
    try {
      const promoted = await promoteSitespeedLatestToNamespace({
        bucket: env.s3Bucket,
        accessKeyId: env.s3Key,
        secretAccessKey: env.s3Secret,
        region: env.s3Region,
        endpoint: env.s3Endpoint,
        forcePathStyle: env.s3ForcePathStyle,
        uploadSlug: slug,
        latestPrefix: graphiteNamespace,
        browser: input.browser,
        connectivity: "native",
      });
      log.info("Promoted clean S3 latest assets", promoted);
    } catch (err) {
      log.warn("S3 latest promote failed", {
        err: err instanceof Error ? err.message : String(err),
        slug,
        graphiteNamespace,
      });
    }
  }

  return {
    exitCode: 0,
    graphiteNamespace,
    slug,
    isMirror,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}
