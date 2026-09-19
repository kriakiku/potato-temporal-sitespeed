import { describe, expect, test } from "bun:test";
import { buildOverlayAss, formatAssTime, slidingSlotCues } from "./overlay-ass";
import {
  OVERLAY_SLOT_LIMIT,
  type OverlayMarker,
  type OverlayTimeline,
} from "./overlay-timeline";

describe("formatAssTime", () => {
  test("formats centiseconds", () => {
    expect(formatAssTime(0)).toBe("0:00:00.00");
    expect(formatAssTime(1230)).toBe("0:00:01.23");
    expect(formatAssTime(61_050)).toBe("0:01:01.05");
  });
});

describe("slidingSlotCues", () => {
  test("drops oldest when (limit+1)th arrives", () => {
    const markers: OverlayMarker[] = [
      { tMs: 1000, role: "ws", label: "a" },
      { tMs: 2000, role: "ws", label: "b" },
      { tMs: 3000, role: "ws", label: "c" },
      { tMs: 4000, role: "ws", label: "d" },
      { tMs: 5000, role: "ws", label: "e" },
      { tMs: 6000, role: "ws", label: "f" },
      { tMs: 7000, role: "ws", label: "g" },
    ];
    const cues = slidingSlotCues(
      markers,
      OVERLAY_SLOT_LIMIT,
      20_000,
      "ws ",
      96,
      28,
    );
    // After 7th event (start 7000), only b..g — a dropped
    const late = cues.filter((l) => l.startsWith("Dialogue: 0,0:00:07.00,"));
    expect(late.some((l) => l.includes(" a"))).toBe(false);
    expect(late.some((l) => l.includes(" g"))).toBe(true);
    expect(late).toHaveLength(OVERLAY_SLOT_LIMIT);
  });
});

describe("buildOverlayAss", () => {
  test("includes timer, nav, iframe, scrubbed event lines", () => {
    const timeline: OverlayTimeline = {
      markers: [
        { tMs: 0, role: "nav", label: "nav" },
        { tMs: 1230, role: "iframe", label: "iframe" },
        { tMs: 2100, role: "ws", label: "api.{tld}/socket" },
        { tMs: 1800, role: "api", label: "GET api.{tld}/v1/x" },
      ],
      ws: [{ tMs: 2100, role: "ws", label: "api.{tld}/socket" }],
      api: [{ tMs: 1800, role: "api", label: "GET api.{tld}/v1/x" }],
      firstIframeMs: 1230,
    };
    const ass = buildOverlayAss(timeline, 5000);
    expect(ass).toContain("t  0.00s");
    expect(ass).toContain("nav     0.00");
    expect(ass).toContain("iframe  1.23");
    // `{` / `}` escaped so ASS does not treat `{tld}` as an override tag
    expect(ass).toContain("api.\\{tld\\}/socket");
    expect(ass).toContain("GET api.\\{tld\\}/v1/x");
    // API block starts at y=264 (below 6 WS slots)
    expect(ass).toContain("\\pos(12,264)");
    expect(ass).toContain("Dialogue:");
  });
});
