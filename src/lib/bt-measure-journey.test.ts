import { describe, expect, test } from "bun:test";
import {
  buildMeasureJourneyScript,
  FULLSCREEN_SELECTOR,
} from "./bt-measure-journey";

describe("buildMeasureJourneyScript", () => {
  test("gates on fullscreen marker then Actions-taps viewport center", () => {
    const src = buildMeasureJourneyScript({
      url: "https://example.com/game#masterSessionId=abc",
      alias: "lobby",
      fullscreenWaitMs: 45_000,
    });
    expect(src).toContain(FULLSCREEN_SELECTOR);
    expect(src).toContain("https://example.com/game#masterSessionId=abc");
    expect(src).toContain("getActions");
    expect(src).toContain('origin: "viewport"');
    expect(src).toContain("innerWidth");
    expect(src).toContain(".click().perform()");
    expect(src).not.toContain("el.click()");
    expect(src).not.toContain("commands.click(");
    expect(src).not.toContain("var warm");
    expect(src).not.toContain("if (warm)");
  });

  test("opens via driver.get before gate; pageComplete after tap", () => {
    const src = buildMeasureJourneyScript({
      url: "https://example.com/",
      alias: "table",
    });
    expect(src).toContain("await commands.measure.start(alias);");
    expect(src).toContain("await driver.get(url);");
    expect(src).not.toContain("await commands.navigate");
    expect(src).toContain("byPageToComplete");
    expect(src).toContain("var fullscreenWaitMs = 10000;");
    const afterGet = src.split("driver.get(url)")[1] ?? "";
    const gateIdx = afterGet.indexOf("commands.wait");
    const completeIdx = afterGet.indexOf("byPageToComplete");
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(gateIdx);
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
