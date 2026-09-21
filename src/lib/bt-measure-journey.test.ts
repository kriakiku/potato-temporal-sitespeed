import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFirstIframeProbeJs,
  buildFullscreenHideJs,
  buildMeasureJourneyScript,
  FULLSCREEN_SELECTOR,
} from "./bt-measure-journey";

describe("buildFullscreenHideJs", () => {
  test("sets display none important on fullscreen selector", () => {
    const js = buildFullscreenHideJs();
    expect(js).toContain("createElement('style')");
    expect(js).toContain("data-test-id");
    expect(js).toContain("fullScreen");
    expect(js).toContain("display:none!important");
    expect(js).toContain("data-potato-hide-fullscreen");
  });
});

describe("buildFirstIframeProbeJs", () => {
  test("installs non-blocking probe fields", () => {
    const js = buildFirstIframeProbeJs();
    expect(js).toContain("__potatoFirstIframeMs");
    expect(js).toContain("__potatoIframeProbe");
    expect(js).toContain("MutationObserver");
    expect(js).toContain("return true;");
    expect(js).not.toContain("setTimeout");
  });
});

describe("buildMeasureJourneyScript", () => {
  test("injects CSS hide for fullscreen marker after driver.get", () => {
    const src = buildMeasureJourneyScript({
      url: "https://example.com/game#masterSessionId=abc",
      alias: "lobby",
    });
    expect(src).toContain(FULLSCREEN_SELECTOR);
    expect(src).toContain("https://example.com/game#masterSessionId=abc");
    expect(src).toContain("display:none!important");
    expect(src).toContain("createElement('style')");
    expect(src).toContain("data-potato-hide-fullscreen");
    expect(src).toContain("await driver.get(url);");
    expect(src).toContain("byPageToComplete");
    expect(src).not.toContain("getActions");
    expect(src).not.toContain("commands.wait(selector");
    expect(src).not.toContain("await commands.navigate");
    expect(src).not.toContain("tapFullscreen");
  });

  test("installs first-iframe probe after driver.get before pageComplete", () => {
    const src = buildMeasureJourneyScript({
      url: "https://example.com/",
      alias: "table",
    });
    expect(src).toContain("__potatoFirstIframeMs");
    expect(src).toContain("Installed first-iframe probe");
    const afterGet = src.split("driver.get(url)")[1] ?? "";
    const probeIdx = afterGet.indexOf("__potatoFirstIframeMs");
    const hideIdx = afterGet.indexOf("data-potato-hide-fullscreen");
    const completeIdx = afterGet.indexOf("byPageToComplete");
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(hideIdx).toBeGreaterThan(probeIdx);
    expect(completeIdx).toBeGreaterThan(hideIdx);
  });

  test("hide runs before pageComplete", () => {
    const src = buildMeasureJourneyScript({
      url: "https://example.com/",
      alias: "table",
    });
    const afterGet = src.split("driver.get(url)")[1] ?? "";
    const hideIdx = afterGet.indexOf("js.run");
    const completeIdx = afterGet.indexOf("byPageToComplete");
    expect(hideIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(hideIdx);
  });

  test("preserves auth-style #hash in embedded URL for driver.get", () => {
    const url =
      "https://example.com/table?language=en#masterSessionId=bfbe3df9a10e473a";
    const src = buildMeasureJourneyScript({ url, alias: "lobby" });
    expect(src).toContain(`var url = ${JSON.stringify(url)};`);
    expect(src).toContain("#masterSessionId=bfbe3df9a10e473a");
    expect(src).toContain("await driver.get(url);");
  });
});

describe("bt-first-iframe.js", () => {
  test("is sync and never waits with setTimeout", () => {
    const path = join(import.meta.dir, "../../scripts/bt-first-iframe.js");
    const src = readFileSync(path, "utf8");
    expect(src).toContain("__potatoFirstIframeMs");
    expect(src).toContain("return {}");
    expect(src).not.toContain("setTimeout");
    expect(src).not.toContain("TIMEOUT_MS");
    expect(src).not.toContain("new Promise");
    expect(src).not.toContain("MutationObserver");
  });
});
