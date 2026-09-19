import { describe, expect, test } from "bun:test";
import { buildSitespeedBrowserArgs } from "../shared/sitespeed-args";

describe("buildSitespeedBrowserArgs overlay flags", () => {
  test("disables browsertime timer and passes script path", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      iterations: 1,
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "cold",
      url: "https://example.com/",
      scriptPath: "/sitespeed.io/bt-first-iframe.js",
    });
    const i = args.indexOf("--browsertime.videoParams.addTimer");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("false");
    expect(args).toContain("--browsertime.script");
    expect(args).toContain("/sitespeed.io/bt-first-iframe.js");
    expect(args.at(-1)).toBe("https://example.com/");
  });

  test("multi journey replaces URL and skips preURL", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      iterations: 1,
      slug: "test",
      metricPrefix: "lobby",
      cacheMode: "warm",
      url: "https://example.com/",
      multiScriptPath: "/sitespeed.io/bt-measure-journey.js",
      scriptPath: "/sitespeed.io/bt-first-iframe.js",
    });
    expect(args.at(-1)).toBe("/sitespeed.io/bt-measure-journey.js");
    expect(args).not.toContain("--preURL");
    expect(args).toContain("--browsertime.timeouts.elementWait");
    expect(args).toContain("60000");
    expect(args).not.toContain("--browsertime.chrome.CPUThrottlingRate");
  });

  test("cpuThrottlingRate adds Chrome CPUThrottlingRate", () => {
    const args = buildSitespeedBrowserArgs({
      browser: "chrome",
      iterations: 1,
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
});
