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
      warm: true,
      fullscreenWaitMs: 45_000,
    });
    expect(src).toContain(FULLSCREEN_SELECTOR);
    expect(src).toContain("https://example.com/game#masterSessionId=abc");
    expect(src).toContain("var warm = true");
    expect(src).toContain("getActions");
    expect(src).toContain('origin: "viewport"');
    expect(src).toContain("innerWidth");
    expect(src).toContain(".click().perform()");
    expect(src).not.toContain("el.click()");
    expect(src).not.toContain("commands.click(");
  });

  test("cold skips warm pre-navigate flag", () => {
    const src = buildMeasureJourneyScript({
      url: "https://example.com/",
      alias: "table",
      warm: false,
    });
    expect(src).toContain("var warm = false");
  });
});
