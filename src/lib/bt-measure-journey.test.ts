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

  test("always starts measure then navigates once", () => {
    const src = buildMeasureJourneyScript({
      url: "https://example.com/",
      alias: "table",
    });
    expect(src).toContain("await commands.measure.start(alias);");
    expect(src).toContain("await commands.navigate(url);");
    // No pre-measure warm navigate
    const beforeMeasure = src.split("measure.start")[0] ?? "";
    expect(beforeMeasure).not.toContain("commands.navigate");
  });
});
