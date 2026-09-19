import { describe, expect, test } from "bun:test";
import {
  buildOverlayTimeline,
  isStaticAssetPath,
  lastN,
} from "./overlay-timeline";

describe("isStaticAssetPath", () => {
  test("detects common static extensions", () => {
    expect(isStaticAssetPath("/app.js")).toBe(true);
    expect(isStaticAssetPath("/a/b.css?v=1")).toBe(true);
    expect(isStaticAssetPath("/font.woff2")).toBe(true);
    expect(isStaticAssetPath("/img/x.PNG")).toBe(true);
    expect(isStaticAssetPath("/v1/players")).toBe(false);
    expect(isStaticAssetPath("/socket")).toBe(false);
  });
});

describe("lastN", () => {
  test("sliding window of OVERLAY_SLOT_LIMIT", () => {
    expect(lastN([1, 2, 3, 4, 5, 6, 7], 6)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(lastN([1, 2], 6)).toEqual([1, 2]);
    expect(lastN([], 6)).toEqual([]);
  });
});

describe("buildOverlayTimeline", () => {
  test("anchors to page host http_start and scrub labels", () => {
    const t0 = 1_000_000;
    const tl = buildOverlayTimeline({
      pageUrl: "https://www.example.com/lobby",
      workflowTld: "example.com",
      firstIframeMs: 1230,
      events: [
        {
          kind: "http_start",
          host: "cdn.other.net",
          method: "GET",
          path: "/boot.js",
          atUnixMs: t0 - 500,
        },
        {
          kind: "http_start",
          host: "www.example.com",
          method: "GET",
          path: "/lobby",
          atUnixMs: t0,
        },
        {
          kind: "http_start",
          host: "api.example.com",
          method: "GET",
          path: "/v1/x?tok=1",
          atUnixMs: t0 + 1800,
        },
        {
          kind: "http_start",
          host: "api.example.com",
          method: "GET",
          path: "/static/app.js",
          atUnixMs: t0 + 1900,
        },
        {
          kind: "ws_start",
          host: "api.example.com",
          path: "/socket?a=1",
          atUnixMs: t0 + 2100,
        },
        {
          kind: "ws_start",
          host: "api.example.com",
          path: "/socket2",
          atUnixMs: t0 + 2450,
        },
        {
          kind: "ws_start",
          host: "api.example.com",
          path: "/socket3",
          atUnixMs: t0 + 3010,
        },
        {
          kind: "ws_start",
          host: "api.example.com",
          path: "/socket4",
          atUnixMs: t0 + 4000,
        },
      ],
    });

    expect(tl.firstIframeMs).toBe(1230);
    expect(tl.markers.find((m) => m.role === "nav")?.tMs).toBe(0);
    expect(tl.markers.find((m) => m.role === "iframe")?.tMs).toBe(1230);
    expect(tl.api).toHaveLength(1);
    expect(tl.api[0]!.label).toBe("GET api.{tld}/v1/x");
    expect(tl.ws).toHaveLength(4);
    expect(lastN(tl.ws, 6).map((m) => m.tMs)).toEqual([
      2100, 2450, 3010, 4000,
    ]);
    // with only 4 ws, lastN(6) returns all 4
    expect(lastN(tl.ws, 3).map((m) => m.tMs)).toEqual([2450, 3010, 4000]);
    expect(tl.ws[0]!.label).toBe("api.{tld}/socket");
  });

  test("clamps negative offsets to 0", () => {
    const tl = buildOverlayTimeline({
      pageUrl: "https://example.com/",
      workflowTld: "example.com",
      events: [
        {
          kind: "http_start",
          host: "example.com",
          method: "GET",
          path: "/",
          atUnixMs: 5000,
        },
        {
          kind: "ws_start",
          host: "example.com",
          path: "/early",
          atUnixMs: 4000,
        },
      ],
    });
    expect(tl.ws[0]!.tMs).toBe(0);
  });
});
