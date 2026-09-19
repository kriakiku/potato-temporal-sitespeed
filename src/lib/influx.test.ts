import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  emitInfluxWrite,
  formatInfluxLine,
  withInfluxPrecisionNs,
} from "./influx";
import {
  extractBrowsertimeFields,
  extractLighthouseScores,
} from "./sitespeed-json";

describe("withInfluxPrecisionNs", () => {
  test("appends precision=ns when missing", () => {
    expect(withInfluxPrecisionNs("http://vm:8428/write")).toBe(
      "http://vm:8428/write?precision=ns",
    );
  });
  test("keeps existing precision", () => {
    expect(withInfluxPrecisionNs("http://vm:8428/write?precision=ms")).toBe(
      "http://vm:8428/write?precision=ms",
    );
  });
});

describe("formatInfluxLine", () => {
  test("tags and int fields", () => {
    const line = formatInfluxLine({
      measurement: "sitespeed_browsertime",
      tags: { country: "BD", direct: true },
      fields: { TTFB: 120, ok: true },
      timestampNs: 1n,
    });
    expect(line).toBe(
      "sitespeed_browsertime,country=BD,direct=true TTFB=120i,ok=t 1",
    );
  });
});

describe("emitInfluxWrite", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("skips when url unset", async () => {
    const result = await emitInfluxWrite(undefined, [
      { measurement: "m", fields: { x: 1 } },
    ]);
    expect(result).toEqual({ sent: 0, skipped: true });
  });

  test("posts LP with Bearer auth and precision", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("Authorization") ?? "";
      seenBody = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await emitInfluxWrite(
      "http://vm:8428/write",
      [
        {
          measurement: "potato_http",
          tags: { path: "/v1/x" },
          fields: { count: 1 },
          timestampNs: 42n,
        },
      ],
      { token: "sekret" },
    );

    expect(result).toEqual({ sent: 1, skipped: false });
    expect(seenUrl).toBe("http://vm:8428/write?precision=ns");
    expect(seenAuth).toBe("Bearer sekret");
    expect(seenBody).toContain("potato_http,path=/v1/x count=1i 42\n");
  });

  test("uses Basic auth when no token", async () => {
    let seenAuth = "";
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("Authorization") ?? "";
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await emitInfluxWrite(
      "http://vm:8428/write",
      [{ measurement: "m", fields: { n: 2 }, timestampNs: 1n }],
      { username: "writer", password: "pass" },
    );

    expect(seenAuth).toBe(
      `Basic ${Buffer.from("writer:pass", "utf8").toString("base64")}`,
    );
  });

  test("throws on non-2xx", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 401 })) as typeof fetch;

    await expect(
      emitInfluxWrite("http://vm:8428/write", [
        { measurement: "m", fields: { n: 1 }, timestampNs: 1n },
      ]),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("extractBrowsertimeFields", () => {
  test("statistics.timings median", () => {
    const fields = extractBrowsertimeFields({
      statistics: {
        timings: {
          FirstVisualChange: { median: 900, mean: 910 },
          ttfb: { median: 80 },
        },
        visualMetrics: {
          SpeedIndex: { median: 1100 },
        },
      },
    });
    expect(fields.FirstVisualChange).toBe(900);
    expect(fields.ttfb).toBe(80);
    expect(fields.visual_SpeedIndex).toBe(1100);
  });

  test("custom firstIframeMs from browsertime script", () => {
    const fields = extractBrowsertimeFields({
      custom: { firstIframeMs: 1234 },
    });
    expect(fields.firstIframeMs).toBe(1234);
  });
});

describe("extractLighthouseScores", () => {
  test("scales 0-1 to 0-100", () => {
    const fields = extractLighthouseScores({
      categories: {
        performance: { score: 0.87 },
      },
    });
    expect(fields.lighthouse_performance).toBeCloseTo(87);
  });
});
