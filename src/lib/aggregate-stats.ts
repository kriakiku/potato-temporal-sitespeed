/**
 * Sitespeed/Browsertime-compatible statistics over N scalar samples.
 * Mirrors Graphite leaf names: median, mean, mdev, min, p10, p90, p99, max.
 */

export const STAT_KEYS = [
  "median",
  "mean",
  "mdev",
  "min",
  "p10",
  "p90",
  "p99",
  "max",
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

export type StatBundle = Record<StatKey, number>;

function sortedFinite(values: number[]): number[] {
  return values
    .filter((n) => typeof n === "number" && Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);
}

/** Percentile with linear interpolation (p in 0..100). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const w = rank - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

function meanOf(sorted: number[]): number {
  let sum = 0;
  for (const n of sorted) sum += n;
  return sum / sorted.length;
}

/** Mean absolute deviation from the mean (browsertime `mdev`). */
function mdevOf(sorted: number[], mean: number): number {
  let sum = 0;
  for (const n of sorted) sum += Math.abs(n - mean);
  return sum / sorted.length;
}

export function computeStats(values: number[]): StatBundle | undefined {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) return undefined;
  const mean = meanOf(sorted);
  return {
    median: percentile(sorted, 50),
    mean,
    mdev: mdevOf(sorted, mean),
    min: sorted[0]!,
    p10: percentile(sorted, 10),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * Expand a stat bundle into Influx fields.
 * Bare `base` = median (dashboard compat); also `base_median`, `base_mean`, …
 */
export function expandStatFields(
  base: string,
  stats: StatBundle,
): Record<string, number> {
  const out: Record<string, number> = { [base]: stats.median };
  for (const key of STAT_KEYS) {
    out[`${base}_${key}`] = stats[key];
  }
  return out;
}

/** Aggregate parallel field maps (same keys) into expanded stat fields. */
export function aggregateFieldMaps(
  maps: Array<Record<string, number>>,
): Record<string, number> {
  const keys = new Set<string>();
  for (const m of maps) {
    for (const k of Object.keys(m)) keys.add(k);
  }
  const out: Record<string, number> = {};
  for (const key of keys) {
    const samples: number[] = [];
    for (const m of maps) {
      const v = m[key];
      if (typeof v === "number" && Number.isFinite(v)) samples.push(v);
    }
    const stats = computeStats(samples);
    if (!stats) continue;
    Object.assign(out, expandStatFields(key, stats));
  }
  return out;
}

/**
 * Index of the sample closest to the median of `values`
 * (ties → middle index among ties, then clamp to array middle).
 */
export function medianSampleIndex(values: number[]): number {
  if (values.length === 0) return 0;
  const stats = computeStats(values);
  if (!stats) return Math.floor((values.length - 1) / 2);
  const target = stats.median;
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const dist = Math.abs(v - target);
    if (
      dist < bestDist ||
      (dist === bestDist &&
        Math.abs(i - (values.length - 1) / 2) <
          Math.abs(bestIdx - (values.length - 1) / 2))
    ) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

