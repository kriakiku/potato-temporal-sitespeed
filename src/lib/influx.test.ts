import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  emitInfluxWrite,
  formatInfluxLine,
  withInfluxPrecisionNs,
} from "./influx";
import {
  extractAxeFields,
  extractBrowsertimeFields,
  extractCoachFields,
  extractLighthouseFields,
  extractLighthouseScores,
  extractPagexrayFields,
  extractSustainableFields,
  extractThirdpartyFields,
} from "./sitespeed-json";
import { buildInfluxPoints } from "./influx-points";

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
      measurement: "potato_browsertime",
      tags: { country: "BD", direct: true },
      fields: { TTFB: 120, ok: true },
      timestampNs: 1n,
    });
    expect(line).toBe(
      "potato_browsertime,country=BD,direct=true TTFB=120i,ok=t 1",
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
    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      seenUrl = String(input);
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("Authorization") ?? "";
      seenBody = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

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
    globalThis.fetch = mock(async (_input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("Authorization") ?? "";
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

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
    globalThis.fetch = mock(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;

    await expect(
      emitInfluxWrite("http://vm:8428/write", [
        { measurement: "m", fields: { n: 1 }, timestampNs: 1n },
      ]),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("extractBrowsertimeFields", () => {
  test("statistics.timings median", () => {
    const { fields } = extractBrowsertimeFields({
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
    const { fields } = extractBrowsertimeFields({
      custom: { firstIframeMs: 1234 },
    });
    expect(fields.firstIframeMs).toBe(1234);
  });

  test("omits negative firstIframeMs from browsertime custom", () => {
    const { fields } = extractBrowsertimeFields({
      custom: { firstIframeMs: -1 },
    });
    expect(fields.firstIframeMs).toBeUndefined();
  });

  test("cpu longTasks and heap", () => {
    const { fields, tagged } = extractBrowsertimeFields({
      statistics: {
        browser: { cpuBenchmark: { median: 42 } },
        cdp: {
          performance: {
            JSHeapTotalSize: { median: 1_000_000 },
            JSHeapUsedSize: { median: 500_000 },
          },
        },
        cpu: {
          longTasks: {
            tasks: { median: 3 },
            durations: { max: 120, median: 40 },
            totalBlockingTime: { median: 80 },
            lastLongTask: { median: 900 },
            beforeFirstPaint: { tasks: { median: 1 } },
            beforeFirstContentfulPaint: { tasks: { median: 2 } },
          },
          categories: {
            scriptEvaluation: { median: 55 },
            paintCompositeRender: { median: 12 },
          },
        },
        pageinfo: {
          domElements: { median: 200 },
          cumulativeLayoutShift: { median: 0.01 },
        },
        console: { error: { median: 2 } },
      },
    });
    expect(fields.cpuBenchmark).toBe(42);
    expect(fields.jsHeapTotalSize).toBe(1_000_000);
    expect(fields.cpu_longTasks_tasks).toBe(3);
    expect(fields.cpu_longTasks_durations_max).toBe(120);
    expect(fields.cpu_longTasks_totalBlockingTime).toBe(80);
    expect(fields.cpu_categories_scriptEvaluation).toBe(55);
    expect(fields.domElements).toBe(200);
    expect(tagged.some((t) => t.tags.cpuCategory === "scriptEvaluation")).toBe(
      true,
    );
    expect(tagged.some((t) => t.tags.consoleName === "error")).toBe(true);
  });
});

describe("extractPagexrayFields", () => {
  test("flat + contentTypes + responseCodes", () => {
    const { fields, tagged } = extractPagexrayFields({
      requests: 40,
      transferSize: 900_000,
      contentSize: 800_000,
      totalDomains: 5,
      cookies: 2,
      firstParty: { cookies: 1 },
      thirdParty: { cookies: 1 },
      responseCodes: { "200": 38, "404": 2 },
      contentTypes: {
        javascript: { requests: 10, transferSize: 100, contentSize: 90 },
        css: { requests: 3, transferSize: 20, contentSize: 18 },
      },
    });
    expect(fields.requests).toBe(40);
    expect(fields.transferSize).toBe(900_000);
    expect(fields.firstPartyCookies).toBe(1);
    const js = tagged.find((t) => t.tags.contentType === "javascript");
    expect(js?.fields.requests).toBe(10);
    const code200 = tagged.find((t) => t.tags.code === "200");
    expect(code200?.fields.requests).toBe(38);
  });
});

describe("extractCoachFields", () => {
  test("advice scores and info", () => {
    const fields = extractCoachFields({
      advice: {
        score: 90,
        performance: { score: 80 },
        bestpractice: { score: 85 },
        privacy: { score: 70 },
        info: {
          domElements: 150,
          domDepth: { avg: 8, max: 20 },
          documentHeight: 4000,
          iframes: 1,
          scripts: 12,
          localStorageSize: 0,
        },
      },
    });
    expect(fields.score).toBe(90);
    expect(fields.performanceScore).toBe(80);
    expect(fields.domDepthAvg).toBe(8);
    expect(fields.iframes).toBe(1);
  });
});

describe("extractAxeFields", () => {
  test("violation counts by impact", () => {
    const fields = extractAxeFields({
      violations: {
        critical: { median: 0 },
        serious: { median: 1 },
        moderate: { median: 2 },
        minor: { median: 3 },
      },
    });
    expect(fields.violationsCritical).toBe(0);
    expect(fields.violationsSerious).toBe(1);
    expect(fields.violationsModerate).toBe(2);
    expect(fields.violationsMinor).toBe(3);
  });
});

describe("extractLighthouseFields", () => {
  test("scales categories and reads audits", () => {
    const fields = extractLighthouseFields({
      categories: {
        performance: { score: 0.87 },
        "best-practices": { score: 0.9 },
      },
      audits: {
        "first-contentful-paint": { numericValue: 1200 },
        "largest-contentful-paint": { numericValue: 2500 },
        "total-blocking-time": { numericValue: 150 },
        "cumulative-layout-shift": { numericValue: 0.05 },
      },
    });
    expect(fields.performance).toBeCloseTo(87);
    expect(fields.best_practices).toBeCloseTo(90);
    expect(fields.audit_first_contentful_paint).toBe(1200);
    expect(fields.audit_largest_contentful_paint).toBe(2500);
  });

  test("legacy extractLighthouseScores keeps lighthouse_ prefix", () => {
    const fields = extractLighthouseScores({
      categories: { performance: { score: 0.5 } },
    });
    expect(fields.lighthouse_performance).toBeCloseTo(50);
  });
});

describe("extractSustainableFields / thirdparty", () => {
  test("co2 fields", () => {
    const fields = extractSustainableFields({
      co2PerPageView: { median: 0.5 },
      co2FirstParty: { median: 0.2 },
      co2ThirdParty: { median: 0.3 },
      totalCO2: { median: 0.5 },
    });
    expect(fields.co2PerPageView).toBe(0.5);
    expect(fields.totalCO2).toBe(0.5);
  });

  test("thirdparty requests and categories", () => {
    const { fields, tagged } = extractThirdpartyFields({
      requests: { total: { median: 20 }, percentage: { median: 40 } },
      category: {
        ads: { requests: { median: 5 }, tools: { median: 2 } },
      },
      tool: {
        googletagmanager: { cpu: { median: 12 } },
      },
    });
    expect(fields.requestsTotal).toBe(20);
    expect(fields.requestsPercentage).toBe(40);
    expect(
      tagged.find((t) => t.tags.thirdPartyCategory === "ads")?.fields.requests,
    ).toBe(5);
    expect(
      tagged.find((t) => t.tags.tool === "googletagmanager")?.fields.cpu,
    ).toBe(12);
  });
});

describe("buildInfluxPoints sitespeed plugins", () => {
  test("emits potato_* measurements with tagged cardinality", () => {
    const points = buildInfluxPoints({
      tags: { metricPrefix: "lobby", country: "BD" },
      workflowTld: "example.com",
      browsertime: { ttfb: 80, cpuBenchmark: 40 },
      browsertimeTagged: [
        { tags: { cpuCategory: "scriptEvaluation" }, fields: { median: 55 } },
      ],
      pagexray: { requests: 10, transferSize: 1000 },
      pagexrayTagged: [
        {
          tags: { contentType: "javascript" },
          fields: { requests: 4, transferSize: 400 },
        },
      ],
      coach: { score: 90 },
      axe: { violationsSerious: 1 },
      lighthouse: { performance: 87, audit_first_contentful_paint: 1200 },
      sustainable: { totalCO2: 0.4 },
      thirdparty: { requestsTotal: 5 },
      thirdpartyTagged: [
        { tags: { tool: "gtm" }, fields: { cpu: 3 } },
      ],
      profile: {},
      baseline: {},
      stats: { dns: [], tlsClient: [], tlsUpstream: [] },
    });
    const names = new Set(points.map((p) => p.measurement));
    expect(names.has("potato_browsertime")).toBe(true);
    expect(names.has("potato_pagexray")).toBe(true);
    expect(names.has("potato_coach")).toBe(true);
    expect(names.has("potato_axe")).toBe(true);
    expect(names.has("potato_lighthouse")).toBe(true);
    expect(names.has("potato_sustainable")).toBe(true);
    expect(names.has("potato_thirdparty")).toBe(true);
    expect(names.has("sitespeed_browsertime")).toBe(false);

    const pxJs = points.find(
      (p) =>
        p.measurement === "potato_pagexray" &&
        p.tags?.contentType === "javascript",
    );
    expect(pxJs?.fields.requests).toBe(4);

    const btCpu = points.find(
      (p) =>
        p.measurement === "potato_browsertime" &&
        p.tags?.cpuCategory === "scriptEvaluation",
    );
    expect(btCpu?.fields.median).toBe(55);
  });

  test("potato_overlay omits missing or negative firstIframeMs", () => {
    const without = buildInfluxPoints({
      tags: { metricPrefix: "lobby", country: "BD" },
      workflowTld: "example.com",
      browsertime: {},
      pagexray: {},
      coach: {},
      axe: {},
      lighthouse: {},
      sustainable: {},
      thirdparty: {},
      profile: {},
      baseline: {},
      stats: { dns: [], tlsClient: [], tlsUpstream: [] },
      overlay: {
        wsMarkers: 1,
        apiMarkers: 2,
        wsShown: 1,
        apiShown: 2,
        burned: false,
      },
    });
    const ov = without.find((p) => p.measurement === "potato_overlay");
    expect(ov?.fields.firstIframeMs).toBeUndefined();

    const withIframe = buildInfluxPoints({
      tags: { metricPrefix: "lobby", country: "BD" },
      workflowTld: "example.com",
      browsertime: {},
      pagexray: {},
      coach: {},
      axe: {},
      lighthouse: {},
      sustainable: {},
      thirdparty: {},
      profile: {},
      baseline: {},
      stats: { dns: [], tlsClient: [], tlsUpstream: [] },
      overlay: {
        wsMarkers: 0,
        apiMarkers: 0,
        wsShown: 0,
        apiShown: 0,
        firstIframeMs: 1500,
        burned: true,
      },
    });
    const ov2 = withIframe.find((p) => p.measurement === "potato_overlay");
    expect(ov2?.fields.firstIframeMs).toBe(1500);
    expect(ov2?.fields.burned).toBe(true);
  });
});
