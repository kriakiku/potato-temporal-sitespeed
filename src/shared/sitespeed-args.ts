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
  /**
   * Apex domain for --firstParty regex (e.g. example.com).
   * Enables pagexray firstParty/thirdParty cookie + request splits across subdomains.
   */
  firstPartyTld?: string;
};

/** Build sitespeed --firstParty regex for an apex TLD (matches host and subdomains). */
export function firstPartyRegexForTld(tld: string): string | undefined {
  const apex = tld.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!apex || !/^[a-z0-9.-]+$/i.test(apex)) return undefined;
  const escaped = apex.replace(/\./g, "\\.");
  return `.*\\.${escaped}`;
}

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
      // Hero visual timings: largest H1 + largest image in viewport
      "--visualElements",
    );
  } else {
    cmd.push("--video", "false");
  }

  const firstParty = input.firstPartyTld
    ? firstPartyRegexForTld(input.firstPartyTld)
    : undefined;
  if (firstParty) {
    cmd.push("--firstParty", firstParty);
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
    // Potato MITM: Chrome error page without these
    "--browsertime.chrome.args",
    "ignore-certificate-errors",
    "--browsertime.chrome.args",
    "allow-insecure-localhost",
    "--browsertime.chrome.args",
    "disable-quic",
    // prefers-color-scheme: dark (mojom PreferredColorScheme: kDark=0, kLight=1)
    "--browsertime.chrome.args",
    "blink-settings=preferredColorScheme=0",
    // WebGPU + WebGL in container (no /dev/dri): SwiftShader Vulkan path.
    // Without enable-unsafe-webgpu, Linux/Xvfb Chrome often returns no adapter.
    "--browsertime.chrome.args",
    "enable-unsafe-webgpu",
    "--browsertime.chrome.args",
    "enable-features=Vulkan",
    "--browsertime.chrome.args",
    "use-angle=vulkan",
    "--browsertime.chrome.args",
    "use-vulkan=swiftshader",
    "--browsertime.chrome.args",
    "use-webgpu-adapter=swiftshader",
    "--browsertime.chrome.args",
    "disable-vulkan-surface",
    // Opt-in SwiftShader for WebGL (Chromium no longer falls back silently)
    "--browsertime.chrome.args",
    "enable-unsafe-swiftshader",
    // Chrome timeline + long tasks; sustainability + axe plugins
    "--cpu",
    // Local greencheck via bind-mounted url2green.json.gz (see url2green.ts).
    // Never pass --sustainable.useGreenWebHostingAPI — without the local file
    // @tgwf/co2 falls through to greencheckmulti HTTP.
    "--sustainable.enable",
    "--axe.enable",
    "--browsertime.timeouts.pageCompleteCheck",
    "180000",
    "--browsertime.timeouts.pageLoad",
    "300000",
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
    // Without --multi, sitespeed treats the .js as a URL list file →
    // getURLs() is empty → options.urls[0] is undefined → startsWith crash.
    cmd.push("--multi");
    if (clearCache) {
      // Must be =true (or "true" as next argv). A bare --browsertime.cacheClearRaw
      // is not always registered as boolean at the sitespeed CLI layer and will
      // swallow the following positional (journey path / URL).
      cmd.push("--browsertime.cacheClearRaw=true");
    }
    cmd.push(input.multiScriptPath);
  } else if (!clearCache) {
    cmd.push("--preURL", input.url);
    cmd.push(input.url);
  } else {
    cmd.push("--browsertime.cacheClearRaw=true");
    cmd.push(input.url);
  }

  return cmd;
}
