import { describe, expect, test } from "bun:test";
import {
  formatInfluxLine,
  parseTelegrafAddr,
} from "./telegraf";
import { extractBrowsertimeFields, extractLighthouseScores } from "./sitespeed-json";

describe("parseTelegrafAddr", () => {
  test("udp default", () => {
    expect(parseTelegrafAddr("127.0.0.1:8094")).toEqual({
      protocol: "udp",
      host: "127.0.0.1",
      port: 8094,
    });
  });
  test("tcp scheme", () => {
    expect(parseTelegrafAddr("tcp://telegraf:8094")).toEqual({
      protocol: "tcp",
      host: "telegraf",
      port: 8094,
    });
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
