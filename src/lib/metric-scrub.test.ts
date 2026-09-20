import { describe, expect, test } from "bun:test";
import {
  normalizeApex,
  scrubHostForMetrics,
  scrubPathForMetrics,
} from "./metric-scrub";
import { buildInfluxPoints } from "./influx-points";

describe("metric-scrub", () => {
  test("strip query and hash", () => {
    expect(scrubPathForMetrics("/api/x?sid=abc#frag")).toBe("/api/x");
    expect(scrubPathForMetrics("")).toBe("/");
  });

  test("replace apex and subdomain with {tld}", () => {
    expect(normalizeApex("https://Example.COM/")).toBe("example.com");
    expect(scrubHostForMetrics("example.com", "example.com")).toBe("{tld}");
    expect(scrubHostForMetrics("api.example.com:443", "example.com")).toBe(
      "api.{tld}",
    );
    expect(scrubHostForMetrics("cdn.other.net", "example.com")).toBe(
      "cdn.other.net",
    );
  });
});

describe("buildInfluxPoints http/ws", () => {
  test("emits http, duplicates, websocket with scrubbed host", () => {
    const points = buildInfluxPoints({
      tags: { metricPrefix: "lobby", country: "BD" },
      workflowTld: "example.com",
      browsertime: {},
      profile: {},
      baseline: {},
      stats: {
        dns: [],
        tlsClient: [],
        tlsUpstream: [],
        http: [
          {
            host: "api.example.com",
            method: "GET",
            path: "/v1/x",
            count: 3,
            errorCount: 0,
            latencyMs: { sumMs: 90, minMs: 20, maxMs: 40 },
          },
        ],
        websocket: [
          {
            host: "ws.example.com",
            path: "/socket",
            count: 1,
            started: 2,
            errorCount: 0,
            latencyMs: { sumMs: 100, minMs: 100, maxMs: 100 },
          },
        ],
      },
    });
    const names = points.map((p) => p.measurement);
    expect(names).toContain("potato_http");
    expect(names).toContain("potato_http_duplicate");
    expect(names).toContain("potato_websocket");
    const http = points.find((p) => p.measurement === "potato_http")!;
    expect(http.tags?.host).toBe("api.{tld}");
    expect(http.tags?.path).toBe("/v1/x");
    const ws = points.find((p) => p.measurement === "potato_websocket")!;
    expect(ws.tags?.host).toBe("ws.{tld}");
    expect(ws.fields.started).toBe(2);
  });

  test("emits potato_http_slow with rank and scrubbed tags", () => {
    const points = buildInfluxPoints({
      tags: { metricPrefix: "lobby", country: "BD" },
      workflowTld: "example.com",
      browsertime: {},
      profile: {},
      baseline: {},
      stats: {
        dns: [],
        tlsClient: [],
        tlsUpstream: [],
        slowHTTP: [
          {
            host: "cdn.example.com",
            method: "GET",
            path: "/big.js",
            durationMs: 900,
            failed: false,
            atUnixMs: 1,
          },
          {
            host: "api.example.com",
            method: "POST",
            path: "/v1/x",
            durationMs: 400,
            failed: true,
            atUnixMs: 2,
          },
        ],
      },
    });
    const slow = points.filter((p) => p.measurement === "potato_http_slow");
    expect(slow).toHaveLength(2);
    expect(slow[0]!.tags?.rank).toBe("1");
    expect(slow[0]!.tags?.host).toBe("cdn.{tld}");
    expect(slow[0]!.fields.durationMs).toBe(900);
    expect(slow[1]!.tags?.rank).toBe("2");
    expect(slow[1]!.fields.failed).toBe(true);
  });

  test("emits potato_cf_cache per status", () => {
    const points = buildInfluxPoints({
      tags: { metricPrefix: "lobby", country: "BD" },
      workflowTld: "example.com",
      browsertime: {},
      profile: {},
      baseline: {},
      stats: {
        dns: [],
        tlsClient: [],
        tlsUpstream: [],
        cfCache: { HIT: 10, MISS: 3, DYNAMIC: 7, NONE: 2 },
      },
    });
    const cf = points.filter((p) => p.measurement === "potato_cf_cache");
    expect(cf).toHaveLength(4);
    const byStatus = Object.fromEntries(
      cf.map((p) => [p.tags?.status, p.fields.count]),
    );
    expect(byStatus).toEqual({
      DYNAMIC: 7,
      HIT: 10,
      MISS: 3,
      NONE: 2,
    });
  });
});
