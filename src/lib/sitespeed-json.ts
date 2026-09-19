import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SitespeedTimingFields = Record<string, number>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Prefer median, then mean, then raw number. */
function pickStat(node: unknown): number | undefined {
  if (node === undefined || node === null) return undefined;
  const direct = asNumber(node);
  if (direct !== undefined) return direct;
  if (!isPlainObject(node)) return undefined;
  return (
    asNumber(node.median) ??
    asNumber(node.mean) ??
    asNumber(node.p50) ??
    asNumber(node.value)
  );
}

function collectTimings(
  timings: Record<string, unknown>,
  out: SitespeedTimingFields,
  prefix = "",
): void {
  for (const [key, val] of Object.entries(timings)) {
    const name = prefix ? `${prefix}_${key}` : key;
    const n = pickStat(val);
    if (n !== undefined) {
      out[name] = n;
      continue;
    }
    if (isPlainObject(val) && !("median" in val) && !("mean" in val)) {
      // Nested groups (e.g. pageTimings) — one level
      for (const [k2, v2] of Object.entries(val)) {
        const n2 = pickStat(v2);
        if (n2 !== undefined) out[`${name}_${k2}`] = n2;
      }
    }
  }
}

/**
 * Extract numeric fields from a browsertime pageSummary / browsertime.json blob.
 */
export function extractBrowsertimeFields(json: unknown): SitespeedTimingFields {
  const out: SitespeedTimingFields = {};
  if (!isPlainObject(json)) return out;

  // Common shapes: { statistics: { timings: … } } or { timings: … } or array of runs
  let root: Record<string, unknown> = json;
  if (Array.isArray(json)) {
    const last = json[json.length - 1];
    if (isPlainObject(last)) root = last;
  }

  const stats = isPlainObject(root.statistics) ? root.statistics : root;
  if (isPlainObject(stats.timings)) {
    collectTimings(stats.timings, out);
  }
  if (isPlainObject(stats.visualMetrics)) {
    collectTimings(stats.visualMetrics, out, "visual");
  }
  // pageSummary often nests under browser.chrome.native or similar — also check googleWebVitals
  if (isPlainObject(stats.googleWebVitals)) {
    collectTimings(stats.googleWebVitals, out, "cwv");
  }

  // browsertime --script metrics land under custom / browserScripts
  const custom =
    (isPlainObject(stats.custom) && stats.custom) ||
    (isPlainObject(root.custom) && root.custom) ||
    (isPlainObject(stats.browserScripts) &&
      isPlainObject((stats.browserScripts as Record<string, unknown>).custom) &&
      ((stats.browserScripts as Record<string, unknown>).custom as Record<
        string,
        unknown
      >)) ||
    undefined;
  if (custom) {
    const fi = pickStat(custom.firstIframeMs) ?? asNumber(custom.firstIframeMs);
    if (fi !== undefined) out.firstIframeMs = fi;
  }

  const transfer = pickStat(
    isPlainObject(stats.pageInfo) ? stats.pageInfo.transferSize : undefined,
  );
  if (transfer !== undefined) out.transferSize = transfer;

  return out;
}

/** Read firstIframeMs from any browsertime JSON under the result tree. */
export async function loadFirstIframeMs(
  resultRoot: string,
): Promise<number | undefined> {
  const fields = await loadSitespeedMetricFields(resultRoot);
  const v = fields.firstIframeMs;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

export function extractLighthouseScores(json: unknown): SitespeedTimingFields {
  const out: SitespeedTimingFields = {};
  if (!isPlainObject(json)) return out;
  const cats = isPlainObject(json.categories) ? json.categories : undefined;
  if (!cats) return out;
  for (const [name, cat] of Object.entries(cats)) {
    if (!isPlainObject(cat)) continue;
    const score = asNumber(cat.score);
    if (score === undefined) continue;
    // Lighthouse scores are 0–1; store as 0–100 for readability
    out[`lighthouse_${name}`] = score <= 1 ? score * 100 : score;
  }
  return out;
}

async function walkFiles(dir: string, pred: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkFiles(full, pred)));
    } else if (ent.isFile() && pred(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as unknown;
}

/**
 * Find and merge browsertime (+ optional lighthouse) metrics from an analysisstorer tree.
 */
export async function loadSitespeedMetricFields(
  resultRoot: string,
): Promise<SitespeedTimingFields> {
  const fields: SitespeedTimingFields = {};
  const jsonFiles = await walkFiles(resultRoot, (n) => n.endsWith(".json"));

  const score = (p: string) => {
    const n = p.replace(/\\/g, "/").toLowerCase();
    let s = 0;
    if (n.endsWith("/browsertime.pagesummary.json") || n.endsWith("/browsertime.json"))
      s += 50;
    if (n.includes("/pages/") && n.includes("/data/")) s += 20;
    if (n.includes("browsertime")) s += 10;
    if (n.includes("lighthouse")) s += 5;
    return s;
  };

  const ranked = [...jsonFiles].sort((a, b) => score(b) - score(a));
  let gotBt = false;
  let gotLh = false;

  for (const path of ranked) {
    const lower = path.replace(/\\/g, "/").toLowerCase();
    try {
      const json = await readJsonFile(path);
      if (!gotBt && lower.includes("browsertime")) {
        Object.assign(fields, extractBrowsertimeFields(json));
        if (Object.keys(fields).length) gotBt = true;
      }
      if (!gotLh && lower.includes("lighthouse")) {
        Object.assign(fields, extractLighthouseScores(json));
        gotLh = true;
      }
    } catch {
      // skip unreadable / non-json
    }
    if (gotBt && gotLh) break;
  }

  return fields;
}

export async function findLocalAsset(
  resultRoot: string,
  ext: ".png" | ".mp4" | ".html",
): Promise<string | undefined> {
  const files = await walkFiles(resultRoot, (n) =>
    n.toLowerCase().endsWith(ext),
  );
  if (files.length === 0) return undefined;

  const score = (p: string) => {
    const n = p.replace(/\\/g, "/").toLowerCase();
    let s = 0;
    if (ext === ".html") {
      if (n.includes("/pages/") && n.endsWith("/index.html")) s += 50;
      if (n.endsWith("/index.html")) s += 20;
      return s;
    }
    if (ext === ".mp4" && n.endsWith(".raw.mp4")) s -= 200;
    if (n.includes("/data/screenshots/") || n.includes("/data/video/")) s += 100;
    if (n.includes("/pages/")) s += 30;
    if (n.endsWith("/afterpagecompletecheck.png")) s += 50;
    if (n.includes("/img/") || n.includes("/ico/")) s -= 100;
    if (n.includes("#") || n.includes("%23")) s -= 10;
    return s;
  };

  return [...files].sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
}
