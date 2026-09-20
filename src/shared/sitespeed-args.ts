import type { CacheMode } from "./types";

/**
 * Closest built-in Chrome DevTools preset to Galaxy A05 (no A05 in the list).
 * A51/71: 412×914 CSS @ 2.625 dpr — mid-range Samsung phone class.
 * @see https://developer.chrome.com/docs/chromedriver/mobile-emulation
 */
export const CHROME_DEVICE_NAME = "Samsung Galaxy A51/71";

/** Example mid-range phone slowdown (document in README; rate comes from workflow input). */
export const CPU_THROTTLING_RATE_EXAMPLE = 4;

/** Always a single browsertime iteration (`-n 1`). */
export const SITESPEED_ITERATIONS = 1;

/** Container path for persistent Chrome profile (host dir bind-mounted under /sitespeed.io). */
export const CONTAINER_CHROME_PROFILE = "/sitespeed.io/chrome-profile";

export type SitespeedBrowserArgsInput = {
  browser: string;
  slug: string;
  metricPrefix: string;
  cacheMode: CacheMode;
  url: string;
  /** Container path for --outputFolder (default /sitespeed.io/results). */
  outputFolder?: string;
  /** Container path for --browsertime.script (first-iframe metric). */
  scriptPath?: string;
  /**
   * Container path to a browsertime multi/journey script.
   * When set, this is the CLI "URL" argument (script navigates).
   */
  multiScriptPath?: string;
  /** Remove Lighthouse plugin (faster e2e / optional prod). */
  removeLighthouse?: boolean;
  /** Remove GPSI plugin (default true — plus1 image ships it). */
  removeGpsi?: boolean;
  /** Chrome CPUThrottlingRate when set (integer ≥ 1). */
  cpuThrottlingRate?: number;
  /**
   * Chrome user-data-dir inside the container (e.g. CONTAINER_CHROME_PROFILE).
   * Used for warm two-phase runs; omit for cold.
   */
  chromeUserDataDir?: string;
  /** Record video (default true). Warmup sets false. */
  video?: boolean;
  /**
   * Force cache clear. Default: true for cold, false for warm.
   */
  clearCache?: boolean;
};

/**
 * Shared sitespeed CLI flags for production activity and local e2e.
 * Writes local JSON/HTML/media; no Graphite/S3 — callers own export.
 * Always `-n 1`.
 */
export function buildSitespeedBrowserArgs(
  input: SitespeedBrowserArgsInput,
): string[] {
  const outputFolder = input.outputFolder ?? "/sitespeed.io/results";
  const video = input.video !== false;
  const clearCache =
    input.clearCache ?? input.cacheMode !== "warm";

  const cmd: string[] = [
    "-b",
    input.browser,
    "-n",
    String(SITESPEED_ITERATIONS),
    "--slug",
    input.slug,
    "--outputFolder",
    outputFolder,
    "--plugins.add",
    "analysisstorer",
  ];

  if (video) {
    cmd.push(
      "--video",
      "--browsertime.videoParams.addTimer",
      "true",
    );
  } else {
    cmd.push("--video", "false");
  }

  cmd.push(
    "--mobile",
    "--browsertime.chrome.mobileEmulation.deviceName",
    CHROME_DEVICE_NAME,
    // PotatoNetwork shapes traffic — do not double-throttle in browsertime
    "-c",
    "native",
    "--browsertime.connectivity.engine",
    "external",
    // Lobby/game URLs use #masterSessionId=… — SPA wait
    "--spa",
    // Potato MITM: Chrome error page without these
    "--browsertime.chrome.args",
    "ignore-certificate-errors",
    "--browsertime.chrome.args",
    "allow-insecure-localhost",
    "--browsertime.chrome.args",
    "disable-quic",
    // Chrome timeline + long tasks; sustainability + axe plugins
    "--cpu",
    "--sustainable.enable",
    "--axe.enable",
    "--browsertime.timeouts.pageCompleteCheck",
    "180000",
    "--browsertime.timeouts.pageLoad",
    "300000",
    // fullScreen control can appear well after first paint
    "--browsertime.timeouts.elementWait",
    "60000",
  );

  // --urlAlias must match getURLs() count. Journey/multi scripts yield 0 HTTP
  // URLs there, so CLI alias mismatches; measure.start(alias) sets the name.
  if (!input.multiScriptPath) {
    cmd.push("--urlAlias", input.metricPrefix);
  }

  if (input.chromeUserDataDir) {
    cmd.push(
      "--browsertime.chrome.args",
      `user-data-dir=${input.chromeUserDataDir}`,
    );
  }

  if (
    input.cpuThrottlingRate !== undefined &&
    Number.isInteger(input.cpuThrottlingRate) &&
    input.cpuThrottlingRate >= 1
  ) {
    cmd.push(
      "--browsertime.chrome.CPUThrottlingRate",
      String(input.cpuThrottlingRate),
    );
  }

  if (input.scriptPath) {
    cmd.push("--browsertime.script", input.scriptPath);
  }

  if (input.removeGpsi !== false) {
    cmd.push("--plugins.remove", "@sitespeed.io/plugin-gpsi");
  }
  if (input.removeLighthouse) {
    cmd.push("--plugins.remove", "@sitespeed.io/plugin-lighthouse");
  }

  if (input.multiScriptPath) {
    if (clearCache) {
      cmd.push("--browsertime.cacheClearRaw");
    }
    cmd.push(input.multiScriptPath);
  } else if (!clearCache) {
    cmd.push("--preURL", input.url);
    cmd.push(input.url);
  } else {
    cmd.push("--browsertime.cacheClearRaw");
    cmd.push(input.url);
  }

  return cmd;
}
