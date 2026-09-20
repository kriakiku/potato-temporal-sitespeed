import { describe, expect, test } from "bun:test";
import {
  aggregateFieldMaps,
  computeStats,
  expandStatFields,
  medianSampleIndex,
} from "./aggregate-stats";

describe("computeStats", () => {
  test("single sample fills all leaves equally", () => {
    const s = computeStats([42]);
    expect(s).toEqual({
      median: 42,
      mean: 42,
      mdev: 0,
      min: 42,
      p10: 42,
      p90: 42,
      p99: 42,
      max: 42,
    });
  });

  test("three samples match sitespeed-style median/mean/min/max", () => {
    const s = computeStats([10, 20, 30]);
    expect(s?.median).toBe(20);
    expect(s?.mean).toBe(20);
    expect(s?.min).toBe(10);
    expect(s?.max).toBe(30);
    expect(s?.mdev).toBe(20 / 3);
  });

  test("ignores non-finite values", () => {
    expect(computeStats([Number.NaN, 5])).toEqual({
      median: 5,
      mean: 5,
      mdev: 0,
      min: 5,
      p10: 5,
      p90: 5,
      p99: 5,
      max: 5,
    });
    expect(computeStats([])).toBeUndefined();
  });
});

describe("expandStatFields / aggregateFieldMaps", () => {
  test("bare field is median plus suffix variants", () => {
    const fields = expandStatFields("ttfb", computeStats([100, 200, 300])!);
    expect(fields.ttfb).toBe(200);
    expect(fields.ttfb_median).toBe(200);
    expect(fields.ttfb_mean).toBe(200);
    expect(fields.ttfb_min).toBe(100);
    expect(fields.ttfb_max).toBe(300);
  });

  test("aggregateFieldMaps unions keys across runs", () => {
    const out = aggregateFieldMaps([
      { a: 1, b: 10 },
      { a: 3 },
      { a: 5, b: 30 },
    ]);
    expect(out.a).toBe(3);
    expect(out.a_median).toBe(3);
    expect(out.b).toBe(20);
    expect(out.b_min).toBe(10);
    expect(out.b_max).toBe(30);
  });
});

describe("medianSampleIndex", () => {
  test("picks the sample closest to median", () => {
    expect(medianSampleIndex([10, 20, 100])).toBe(1);
    expect(medianSampleIndex([1])).toBe(0);
  });
});
