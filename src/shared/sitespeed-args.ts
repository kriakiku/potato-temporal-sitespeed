import type { CacheMode } from "./types";

/**
 * Closest built-in Chrome DevTools preset to Galaxy A05 (no A05 in the list).
 * A51/71: 412×914 CSS @ 2.625 dpr — mid-range Samsung phone class.
 * @see https://developer.chrome.com/docs/chromedriver/mobile-emulation
 */
export const CHROME_DEVICE_NAME = "Samsung Galaxy A51/71";

/** Example mid-range phone slowdown (document in README; rate comes from workflow input). */
export const CPU_THROTTLING_RATE_EXAMPLE = 4;

export type SitespeedBrowserArgsInput = {
  browser: string;
  iterations: number;
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
   * When set, this is the CLI "URL" argument (script navigates); warm/cold
   * is handled inside the journey (no --preURL).
   */
  multiScriptPath?: string;
  /** Remove Lighthouse plugin (faster e2e / optional prod). */
  removeLighthouse?: boolean;
  /** Remove GPSI plugin (default true — plus1 image ships it). */
  removeGpsi?: boolean;
  /** Chrome CPUThrottlingRate when set (integer ≥ 1). */
  cpuThrottlingRate?: number;
};

/**
 * Shared sitespeed CLI flags for production activity and local e2e.
 * Writes local JSON/HTML/media; no Graphite/S3 — callers own export.
 */
export function buildSitespeedBrowserArgs(
  input: SitespeedBrowserArgsInput,
): string[] {
  const outputFolder = input.outputFolder ?? "/sitespeed.io/results";
  const cmd: string[] = [
    "-b",
    input.browser,
    "-n",
    String(input.iterations),
    "--slug",
    input.slug,
    "--outputFolder",
    outputFolder,
    "--plugins.add",
    "analysisstorer",
    "--video",
    // Custom overlay is burned in by the worker after the run
    "--browsertime.videoParams.addTimer",
    "false",
    "--mobile",
    "--browsertime.chrome.mobileEmulation.deviceName",
    CHROME_DEVICE_NAME,
    // PotatoNetwork shapes traffic — do not double-throttle in browsertime
    "-c",
    "native",
    "--browsertime.connectivity.engine",
    "external",
    // Lobby/game URLs use #masterSessionId=… — SPA wait; alias keeps names clean
    "--spa",
    "--urlAlias",
    input.metricPrefix,
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
  ];

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
    // Journey owns navigation + optional warm pre-navigate
    if (input.cacheMode !== "warm") {
      cmd.push("--browsertime.cacheClearRaw");
    }
    cmd.push(input.multiScriptPath);
  } else if (input.cacheMode === "warm") {
    cmd.push("--preURL", input.url);
    cmd.push(input.url);
  } else {
    cmd.push("--browsertime.cacheClearRaw");
    cmd.push(input.url);
  }

  return cmd;
}
