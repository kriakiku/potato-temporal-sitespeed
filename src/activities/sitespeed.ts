import { heartbeat, log } from "@temporalio/activity";
import { assertExportConfig, getEnv } from "../lib/env";
import {
  resolveEndpointForPotatoNetns,
  resolveHostForPotatoNetns,
} from "../lib/host-gateway";
import { podman } from "../lib/podman";
import {
  buildGraphiteNamespace,
  buildResultSlug,
  resolveIsMirror,
} from "../shared/graphite-ns";
import type { CacheMode, PotatoTier } from "../shared/types";

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
 * bash -c '…; exec /start.sh "$@"' name -- args… keeps args unquoted safely.
 */
function sitespeedEntrypointCmd(args: string[]): {
  entrypoint: string[];
  cmd: string[];
} {
  const script = [
    "set +e",
    'CA=/potato-data/ca/potatonetwork-ca.pem',
    'if [ -f "$CA" ]; then',
    "  mkdir -p /usr/local/share/ca-certificates /etc/ssl/certs 2>/dev/null",
    '  cp "$CA" /usr/local/share/ca-certificates/potatonetwork.crt 2>/dev/null',
    '  cp "$CA" /etc/ssl/certs/potatonetwork.pem 2>/dev/null',
    "  command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1",
    // Chrome NSS DB (image pre-inits /root/.pki/nssdb; start.sh sets HOME=/tmp)
    '  if command -v certutil >/dev/null; then',
    '    for db in /root/.pki/nssdb /tmp/.pki/nssdb; do',
    '      mkdir -p "$db" 2>/dev/null',
    '      if [ ! -f "$db/cert9.db" ] && [ ! -f "$db/cert8.db" ]; then',
    '        certutil -d "sql:$db" -N --empty-password >/dev/null 2>&1',
    "      fi",
    '      certutil -d "sql:$db" -D -n potatonetwork >/dev/null 2>&1',
    '      certutil -d "sql:$db" -A -t "C,," -n potatonetwork -i "$CA" >/dev/null 2>&1',
    "    done",
    "  fi",
    "fi",
    "set -e",
    'exec /start.sh "$@"',
  ].join("\n");

  return {
    entrypoint: ["/bin/bash", "-c"],
    // $0 = sitespeed-wrap; "$@" = sitespeed CLI args
    cmd: [script, "sitespeed-wrap", ...args],
  };
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
    // Lobby URLs use #masterSessionId=… — SPA mode avoids false nav retries
    "--spa",
    // Potato MITM: Chrome error page (chrome-error://chromewebdata/) without these
    "--browsertime.chrome.args",
    "ignore-certificate-errors",
    "--browsertime.chrome.args",
    "allow-insecure-localhost",
    // Transparent MITM often breaks QUIC; force TCP/TLS the proxy can terminate
    "--browsertime.chrome.args",
    "disable-quic",
    // Shaped + heavy lobby JS: give pageCompleteCheck more room than default 60s
    "--browsertime.timeouts.pageCompleteCheck",
    "180000",
    "--browsertime.timeouts.pageLoad",
    "300000",
  ];

  // Empty Lighthouse category scores → Graphite plugin rejects the message and
  // sitespeed exits 1. Disable with SITESPEED_LIGHTHOUSE=false when needed.
  if (!env.sitespeedLighthouse) {
    cmd.push("--plugins.remove", "@sitespeed.io/plugin-lighthouse");
  }

  if (input.cacheMode === "warm") {
    // Same session: hit URL once to fill cache, then measure
    cmd.push("--preURL", input.url);
  } else {
    cmd.push("--browsertime.cacheClearRaw");
  }

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
    cmd.push("--graphite.addSlugToKey", "true");
    if (env.graphiteAuth) {
      cmd.push("--graphite.auth", env.graphiteAuth);
    }
  }

  if (env.s3Bucket && env.s3Key && env.s3Secret) {
    cmd.push("--s3.bucketname", env.s3Bucket);
    cmd.push("--s3.key", env.s3Key);
    cmd.push("--s3.secret", env.s3Secret);
    if (env.s3Endpoint) {
      cmd.push(
        "--s3.endpoint",
        await resolveEndpointForPotatoNetns(env.s3Endpoint),
      );
    }
    if (env.s3Region) cmd.push("--s3.region", env.s3Region);
    if (env.s3ForcePathStyle) {
      cmd.push("--s3.options.forcePathStyle", "true");
    }
    if (env.s3ResultBaseUrl) {
      cmd.push(
        "--resultBaseURL",
        await resolveEndpointForPotatoNetns(env.s3ResultBaseUrl),
      );
    }
    // Copy last screenshot/video/json next to the slug folder root so Grafana
    // can resolve $resulturl/$testname/$group.$page.$browser.$connectivity.*
    // without the per-run timestamp directory.
    cmd.push("--copyLatestFilesToBase", "true");
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
  if (exitCode !== 0) {
    if (isLighthouseGraphiteEmptyDataFailure(combined)) {
      log.warn(
        "sitespeed exited non-zero due to empty Lighthouse→Graphite payload; treating as success (Browsertime/S3 may still have completed)",
        { exitCode, slug },
      );
    } else {
      throw new Error(summarizeSitespeedFailure(exitCode, combined));
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
