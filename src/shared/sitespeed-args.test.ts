import { describe, expect, test } from "bun:test";
import {
  buildSitespeedBrowserArgs,
  CONTAINER_CHROME_PROFILE,
  SITESPEED_ITERATIONS,
} from "../shared/sitespeed-args";

describe("buildSitespeedBrowserArgs", () => {
  test("always uses -n 1 and enables browsertime timer", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "cold",
      url: "https://example.com/",
      scriptPath: "/sitespeed.io/bt-first-iframe.js",
    });
    const n = args.indexOf("-n");
    expect(args[n + 1]).toBe(String(SITESPEED_ITERATIONS));
    const i = args.indexOf("--browsertime.videoParams.addTimer");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("true");
    expect(args).toContain("--sustainable.enable");
    expect(args).not.toContain("--sustainable.useGreenWebHostingAPI");
    expect(args).toContain("--browsertime.script");
    expect(args).toContain("/sitespeed.io/bt-first-iframe.js");
    expect(args.at(-1)).toBe("https://example.com/");
    expect(args).toContain("--browsertime.cacheClearRaw=true");
    expect(args).not.toContain("--browsertime.cacheClearRaw");
  });

  test("multi journey cold uses cacheClearRaw=true so path is not swallowed", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "cold",
      url: "https://example.com/",
      multiScriptPath: "/sitespeed.io/bt-measure-journey.js",
    });
    expect(args).toContain("--multi");
    expect(args).toContain("--browsertime.cacheClearRaw=true");
    expect(args.at(-1)).toBe("/sitespeed.io/bt-measure-journey.js");
    const clearIdx = args.indexOf("--browsertime.cacheClearRaw=true");
    const multiIdx = args.indexOf("--multi");
    expect(clearIdx).toBeGreaterThan(multiIdx);
    expect(clearIdx).toBeLessThan(args.length - 1);
  });

  test("multi journey replaces URL and skips preURL", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "warm",
      url: "https://example.com/",
      multiScriptPath: "/sitespeed.io/bt-measure-journey.js",
      scriptPath: "/sitespeed.io/bt-first-iframe.js",
      clearCache: false,
      chromeUserDataDir: CONTAINER_CHROME_PROFILE,
    });
    expect(args.at(-1)).toBe("/sitespeed.io/bt-measure-journey.js");
    expect(args).toContain("--multi");
    expect(args).not.toContain("--preURL");
    expect(args).not.toContain("--browsertime.cacheClearRaw");
    expect(args).not.toContain("--browsertime.cacheClearRaw=true");
    expect(args).toContain("--browsertime.timeouts.elementWait");
    expect(args).toContain("60000");
    expect(args).not.toContain("--urlAlias");
    expect(args).not.toContain("--browsertime.chrome.CPUThrottlingRate");
    expect(args).toContain(`user-data-dir=${CONTAINER_CHROME_PROFILE}`);
  });

  test("plain URL does not set --multi", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "cold",
      url: "https://example.com/",
    });
    expect(args).not.toContain("--multi");
  });

  test("plain URL keeps urlAlias", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "cold",
      url: "https://example.com/",
    });
    const i = args.indexOf("--urlAlias");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("lobby");
  });

  test("cpuThrottlingRate adds Chrome CPUThrottlingRate", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "cold",
      url: "https://example.com/",
      cpuThrottlingRate: 4,
    });
    const i = args.indexOf("--browsertime.chrome.CPUThrottlingRate");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("4");
  });

  test("video false disables recording", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      slug: "warmup",
      metricPrefix: "lobby",
      cacheMode: "warm",
      url: "https://example.com/",
      video: false,
      clearCache: false,
    });
    const i = args.indexOf("--video");
    expect(args[i + 1]).toBe("false");
    expect(args).not.toContain("--browsertime.videoParams.addTimer");
  });
});
