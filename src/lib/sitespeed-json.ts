import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SitespeedTimingFields = Record<string, number>;

/** One Influx point with extra cardinality tags (contentType, code, …). */
export type TaggedMetricPoint = {
  tags: Record<string, string>;
  fields: SitespeedTimingFields;
};

export type SitespeedMetricsBundle = {
  browsertime: SitespeedTimingFields;
  /** cpu.categories.*, console.* */
  browsertimeTagged: TaggedMetricPoint[];
  pagexray: SitespeedTimingFields;
  /** contentTypes.*, responseCodes.* */
  pagexrayTagged: TaggedMetricPoint[];
  coach: SitespeedTimingFields;
  axe: SitespeedTimingFields;
  lighthouse: SitespeedTimingFields;
  sustainable: SitespeedTimingFields;
  thirdparty: SitespeedTimingFields;
  /** category.* / tool.* */
  thirdpartyTagged: TaggedMetricPoint[];
};

export function emptySitespeedMetricsBundle(): SitespeedMetricsBundle {
  return {
    browsertime: {},
    browsertimeTagged: [],
    pagexray: {},
    pagexrayTagged: [],
    coach: {},
    axe: {},
    lighthouse: {},
    sustainable: {},
    thirdparty: {},
    thirdpartyTagged: [],
  };
}

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
export function pickStat(node: unknown): number | undefined {
  if (node === undefined || node === null) return undefined;
  const direct = asNumber(node);
  if (direct !== undefined) return direct;
  if (!isPlainObject(node)) return undefined;
  return (
    asNumber(node.median) ??
    asNumber(node.mean) ??
    asNumber(node.p50) ??
    asNumber(node.value) ??
    asNumber(node.max)
  );
}

/** pickStat but prefer max when present (longTasks.durations.max). */
function pickStatPreferMax(node: unknown): number | undefined {
  if (node === undefined || node === null) return undefined;
  if (isPlainObject(node) && asNumber(node.max) !== undefined) {
    return asNumber(node.max);
  }
  return pickStat(node);
}

function setField(
  out: SitespeedTimingFields,
  name: string,
  node: unknown,
  preferMax = false,
): void {
  const n = preferMax ? pickStatPreferMax(node) : pickStat(node);
  if (n !== undefined) out[name] = n;
}

function sanitizeFieldLeaf(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
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
      for (const [k2, v2] of Object.entries(val)) {
        const n2 = pickStat(v2);
        if (n2 !== undefined) out[`${name}_${k2}`] = n2;
      }
    }
  }
}

function unwrapRoot(json: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(json)) {
    const last = json[json.length - 1];
    return isPlainObject(last) ? last : undefined;
  }
  return isPlainObject(json) ? json : undefined;
}

/**
 * Extract numeric fields from a browsertime pageSummary / browsertime.json blob.
 */
export function extractBrowsertimeFields(json: unknown): {
  fields: SitespeedTimingFields;
  tagged: TaggedMetricPoint[];
} {
  const out: SitespeedTimingFields = {};
  const tagged: TaggedMetricPoint[] = [];
  const root = unwrapRoot(json);
  if (!root) return { fields: out, tagged };

  const stats = isPlainObject(root.statistics) ? root.statistics : root;

  if (isPlainObject(stats.timings)) {
    const timings = stats.timings;
    // Collect standard timing leaves, but handle nested userTimings / elementTimings specially
    for (const [key, val] of Object.entries(timings)) {
      if (key === "userTimings" || key === "elementTimings") continue;
      const n = pickStat(val);
      if (n !== undefined) {
        out[key] = n;
        continue;
      }
      if (isPlainObject(val) && !("median" in val) && !("mean" in val)) {
        for (const [k2, v2] of Object.entries(val)) {
          const n2 = pickStat(v2);
          if (n2 !== undefined) out[`${key}_${k2}`] = n2;
        }
      }
    }

    setField(out, "timeToContentfulPaint", timings.timeToContentfulPaint);
    setField(out, "timeToFirstInteractive", timings.timeToFirstInteractive);

    if (isPlainObject(timings.userTimings)) {
      const ut = timings.userTimings;
      if (isPlainObject(ut.marks)) {
        for (const [name, val] of Object.entries(ut.marks)) {
          setField(out, `userTiming_mark_${sanitizeFieldLeaf(name)}`, val);
        }
      }
      if (isPlainObject(ut.measures)) {
        for (const [name, val] of Object.entries(ut.measures)) {
          setField(out, `userTiming_measure_${sanitizeFieldLeaf(name)}`, val);
        }
      }
    }

    if (isPlainObject(timings.elementTimings)) {
      for (const [name, val] of Object.entries(timings.elementTimings)) {
        if (isPlainObject(val)) {
          setField(
            out,
            `elementTiming_${sanitizeFieldLeaf(name)}_renderTime`,
            val.renderTime ?? val,
          );
        } else {
          setField(
            out,
            `elementTiming_${sanitizeFieldLeaf(name)}_renderTime`,
            val,
          );
        }
      }
    }
  }

  if (isPlainObject(stats.visualMetrics)) {
    collectTimings(stats.visualMetrics, out, "visual");
  }
  if (isPlainObject(stats.googleWebVitals)) {
    collectTimings(stats.googleWebVitals, out, "cwv");
  }

  // browser.cpuBenchmark
  if (isPlainObject(stats.browser)) {
    setField(out, "cpuBenchmark", stats.browser.cpuBenchmark);
  }

  // cdp.performance heaps
  if (isPlainObject(stats.cdp) && isPlainObject(stats.cdp.performance)) {
    const perf = stats.cdp.performance;
    setField(out, "jsHeapTotalSize", perf.JSHeapTotalSize);
    setField(out, "jsHeapUsedSize", perf.JSHeapUsedSize);
  }

  // cpu longTasks + categories
  if (isPlainObject(stats.cpu)) {
    const cpu = stats.cpu;
    if (isPlainObject(cpu.longTasks)) {
      const lt = cpu.longTasks;
      setField(out, "cpu_longTasks_tasks", lt.tasks);
      setField(out, "cpu_longTasks_durations_max", lt.durations, true);
      setField(out, "cpu_longTasks_totalBlockingTime", lt.totalBlockingTime);
      setField(out, "cpu_longTasks_lastLongTask", lt.lastLongTask);
      if (isPlainObject(lt.beforeFirstPaint)) {
        setField(
          out,
          "cpu_longTasks_beforeFirstPaint_tasks",
          lt.beforeFirstPaint.tasks,
        );
      }
      if (isPlainObject(lt.beforeFirstContentfulPaint)) {
        setField(
          out,
          "cpu_longTasks_beforeFirstContentfulPaint_tasks",
          lt.beforeFirstContentfulPaint.tasks,
        );
      }
    }
    if (isPlainObject(cpu.categories)) {
      for (const [cat, val] of Object.entries(cpu.categories)) {
        const n = pickStat(val);
        if (n === undefined) continue;
        tagged.push({
          tags: { cpuCategory: sanitizeFieldLeaf(cat) },
          fields: { median: n },
        });
        // Also flat fields for the two board favourites
        if (cat === "paintCompositeRender" || cat === "scriptEvaluation") {
          out[`cpu_categories_${cat}`] = n;
        }
      }
    }
    if (isPlainObject(cpu.events)) {
      for (const [ev, val] of Object.entries(cpu.events)) {
        const n = pickStat(val);
        if (n !== undefined) {
          out[`cpu_events_${sanitizeFieldLeaf(ev)}`] = n;
        }
      }
    }
  }

  // pageinfo
  const pageInfo =
    (isPlainObject(stats.pageinfo) && stats.pageinfo) ||
    (isPlainObject(stats.pageInfo) && stats.pageInfo) ||
    undefined;
  if (pageInfo) {
    setField(out, "domElements", pageInfo.domElements);
    setField(out, "cumulativeLayoutShift", pageInfo.cumulativeLayoutShift);
    setField(out, "transferSize", pageInfo.transferSize);
  }

  setField(out, "errors", stats.errors);

  if (isPlainObject(stats.deltaToTFFB)) {
    for (const [k, v] of Object.entries(stats.deltaToTFFB)) {
      setField(out, `deltaToTFFB_${sanitizeFieldLeaf(k)}`, v);
    }
  }

  if (isPlainObject(stats.renderBlocking)) {
    const rb = stats.renderBlocking;
    if (isPlainObject(rb.recalculateStyle)) {
      const rs = rb.recalculateStyle;
      for (const phase of ["beforeFCP", "beforeLCP"] as const) {
        if (!isPlainObject(rs[phase])) continue;
        const p = rs[phase] as Record<string, unknown>;
        setField(
          out,
          `renderBlocking_recalculateStyle_${phase}_durationInMillis`,
          p.durationInMillis,
        );
        setField(
          out,
          `renderBlocking_recalculateStyle_${phase}_elements`,
          p.elements,
        );
      }
    }
  }

  // console.* → tagged
  if (isPlainObject(stats.console)) {
    for (const [name, val] of Object.entries(stats.console)) {
      const n = pickStat(val);
      if (n === undefined) continue;
      tagged.push({
        tags: { consoleName: sanitizeFieldLeaf(name) },
        fields: { count: n },
      });
    }
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

  return { fields: out, tagged };
}

export function extractPagexrayFields(json: unknown): {
  fields: SitespeedTimingFields;
  tagged: TaggedMetricPoint[];
} {
  const out: SitespeedTimingFields = {};
  const tagged: TaggedMetricPoint[] = [];
  const root = unwrapRoot(json);
  if (!root) return { fields: out, tagged };

  // pageSummary shape: { statistics: { … } } or flat pagexray document
  const stats = isPlainObject(root.statistics) ? root.statistics : root;
  const px =
    (isPlainObject(stats.pagexray) && stats.pagexray) ||
    stats;

  setField(out, "requests", px.requests);
  setField(out, "transferSize", px.transferSize);
  setField(out, "contentSize", px.contentSize);
  setField(out, "totalDomains", px.totalDomains);
  setField(out, "cookies", px.cookies);
  setField(out, "expireStats", px.expireStats);
  setField(out, "lastModifiedStats", px.lastModifiedStats);

  if (isPlainObject(px.firstParty)) {
    setField(out, "firstPartyCookies", px.firstParty.cookies);
  }
  if (isPlainObject(px.thirdParty)) {
    setField(out, "thirdPartyCookies", px.thirdParty.cookies);
  }

  if (isPlainObject(px.responseCodes)) {
    for (const [code, val] of Object.entries(px.responseCodes)) {
      const n = pickStat(val) ?? asNumber(val);
      if (n === undefined) continue;
      tagged.push({
        tags: { code: sanitizeFieldLeaf(code) },
        fields: { requests: n },
      });
    }
  }

  if (isPlainObject(px.contentTypes)) {
    for (const [ctype, val] of Object.entries(px.contentTypes)) {
      if (!isPlainObject(val)) continue;
      const fields: SitespeedTimingFields = {};
      setField(fields, "contentSize", val.contentSize);
      setField(fields, "transferSize", val.transferSize);
      setField(fields, "requests", val.requests);
      if (Object.keys(fields).length === 0) continue;
      tagged.push({
        tags: { contentType: sanitizeFieldLeaf(ctype) },
        fields,
      });
    }
  }

  return { fields: out, tagged };
}

export function extractCoachFields(json: unknown): SitespeedTimingFields {
  const out: SitespeedTimingFields = {};
  const root = unwrapRoot(json);
  if (!root) return out;

  // coach.advice or advice at root / under statistics
  let advice: Record<string, unknown> | undefined;
  if (isPlainObject(root.advice)) advice = root.advice;
  else if (isPlainObject(root.coach) && isPlainObject(root.coach.advice)) {
    advice = root.coach.advice as Record<string, unknown>;
  } else if (
    isPlainObject(root.statistics) &&
    isPlainObject((root.statistics as Record<string, unknown>).advice)
  ) {
    advice = (root.statistics as Record<string, unknown>).advice as Record<
      string,
      unknown
    >;
  }
  if (!advice) return out;

  setField(out, "score", advice.score);

  for (const [cat, key] of [
    ["performance", "performanceScore"],
    ["bestpractice", "bestpracticeScore"],
    ["privacy", "privacyScore"],
  ] as const) {
    if (isPlainObject(advice[cat])) {
      setField(out, key, (advice[cat] as Record<string, unknown>).score);
    }
  }

  if (isPlainObject(advice.info)) {
    const info = advice.info;
    setField(out, "domElements", info.domElements);
    setField(out, "documentHeight", info.documentHeight);
    setField(out, "iframes", info.iframes);
    setField(out, "scripts", info.scripts);
    setField(out, "localStorageSize", info.localStorageSize);
    if (isPlainObject(info.domDepth)) {
      setField(out, "domDepthAvg", info.domDepth.avg);
      setField(out, "domDepthMax", info.domDepth.max);
    }
  }

  return out;
}

export function extractAxeFields(json: unknown): SitespeedTimingFields {
  const out: SitespeedTimingFields = {};
  const root = unwrapRoot(json);
  if (!root) return out;

  const violations =
    (isPlainObject(root.violations) && root.violations) ||
    (isPlainObject(root.axe) &&
      isPlainObject((root.axe as Record<string, unknown>).violations) &&
      ((root.axe as Record<string, unknown>).violations as Record<
        string,
        unknown
      >)) ||
    (isPlainObject(root.statistics) &&
      isPlainObject((root.statistics as Record<string, unknown>).violations) &&
      ((root.statistics as Record<string, unknown>).violations as Record<
        string,
        unknown
      >)) ||
    undefined;
  if (!violations) return out;

  for (const [impact, field] of [
    ["critical", "violationsCritical"],
    ["serious", "violationsSerious"],
    ["moderate", "violationsModerate"],
    ["minor", "violationsMinor"],
  ] as const) {
    setField(out, field, violations[impact]);
  }
  return out;
}

/**
 * Lighthouse categories (0–100) + key audit numericValues.
 * Field names omit the lighthouse_ prefix — measurement is potato_lighthouse.
 */
export function extractLighthouseFields(json: unknown): SitespeedTimingFields {
  const out: SitespeedTimingFields = {};
  if (!isPlainObject(json)) return out;

  const cats = isPlainObject(json.categories) ? json.categories : undefined;
  if (cats) {
    for (const [name, cat] of Object.entries(cats)) {
      if (!isPlainObject(cat)) continue;
      const score = asNumber(cat.score);
      if (score === undefined) continue;
      const field = sanitizeFieldLeaf(name.replace(/-/g, "_"));
      out[field] = score <= 1 ? score * 100 : score;
    }
  }

  const audits = isPlainObject(json.audits) ? json.audits : undefined;
  if (audits) {
    for (const id of [
      "first-contentful-paint",
      "largest-contentful-paint",
      "total-blocking-time",
      "cumulative-layout-shift",
    ] as const) {
      const audit = audits[id];
      if (!isPlainObject(audit)) continue;
      const n = asNumber(audit.numericValue);
      if (n === undefined) continue;
      out[`audit_${sanitizeFieldLeaf(id.replace(/-/g, "_"))}`] = n;
    }
  }

  return out;
}

/** @deprecated prefer extractLighthouseFields; keeps lighthouse_ prefix for legacy tests */
export function extractLighthouseScores(json: unknown): SitespeedTimingFields {
  const raw = extractLighthouseFields(json);
  const out: SitespeedTimingFields = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("audit_")) continue;
    out[`lighthouse_${k}`] = v;
  }
  return out;
}

export function extractSustainableFields(json: unknown): SitespeedTimingFields {
  const out: SitespeedTimingFields = {};
  const root = unwrapRoot(json);
  if (!root) return out;

  const sus =
    (isPlainObject(root.sustainable) && root.sustainable) ||
    (isPlainObject(root.statistics) &&
      isPlainObject((root.statistics as Record<string, unknown>).sustainable) &&
      ((root.statistics as Record<string, unknown>).sustainable as Record<
        string,
        unknown
      >)) ||
    root;

  setField(out, "co2PerPageView", sus.co2PerPageView);
  setField(out, "co2FirstParty", sus.co2FirstParty);
  setField(out, "co2ThirdParty", sus.co2ThirdParty);
  setField(out, "totalCO2", sus.totalCO2);
  return out;
}

export function extractThirdpartyFields(json: unknown): {
  fields: SitespeedTimingFields;
  tagged: TaggedMetricPoint[];
} {
  const out: SitespeedTimingFields = {};
  const tagged: TaggedMetricPoint[] = [];
  const root = unwrapRoot(json);
  if (!root) return { fields: out, tagged };

  const tp =
    (isPlainObject(root.thirdparty) && root.thirdparty) ||
    (isPlainObject(root.statistics) &&
      isPlainObject((root.statistics as Record<string, unknown>).thirdparty) &&
      ((root.statistics as Record<string, unknown>).thirdparty as Record<
        string,
        unknown
      >)) ||
    root;

  if (isPlainObject(tp.requests)) {
    setField(out, "requestsTotal", tp.requests.total);
    setField(out, "requestsPercentage", tp.requests.percentage);
  } else {
    setField(out, "requestsTotal", tp.requests);
  }

  if (isPlainObject(tp.category)) {
    for (const [cat, val] of Object.entries(tp.category)) {
      if (!isPlainObject(val)) continue;
      const fields: SitespeedTimingFields = {};
      setField(fields, "requests", val.requests);
      setField(fields, "tools", val.tools);
      if (Object.keys(fields).length === 0) continue;
      tagged.push({
        tags: { thirdPartyCategory: sanitizeFieldLeaf(cat) },
        fields,
      });
    }
  }

  if (isPlainObject(tp.tool)) {
    for (const [tool, val] of Object.entries(tp.tool)) {
      const cpu =
        isPlainObject(val) ? pickStat(val.cpu) ?? pickStat(val) : pickStat(val);
      if (cpu === undefined) continue;
      tagged.push({
        tags: { tool: sanitizeFieldLeaf(tool) },
        fields: { cpu },
      });
    }
  }

  return { fields: out, tagged };
}

/** Read firstIframeMs from any browsertime JSON under the result tree. */
export async function loadFirstIframeMs(
  resultRoot: string,
): Promise<number | undefined> {
  const bundle = await loadSitespeedMetrics(resultRoot);
  const v = bundle.browsertime.firstIframeMs;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

/**
 * @deprecated Use loadSitespeedMetrics — merges browsertime + lighthouse into one flat map.
 */
export async function loadSitespeedMetricFields(
  resultRoot: string,
): Promise<SitespeedTimingFields> {
  const b = await loadSitespeedMetrics(resultRoot);
  return { ...b.browsertime, ...b.lighthouse };
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

function pathScore(p: string): number {
  const n = p.replace(/\\/g, "/").toLowerCase();
  let s = 0;
  if (
    n.endsWith("/browsertime.pagesummary.json") ||
    n.endsWith("/browsertime.json")
  )
    s += 50;
  if (n.includes("pagexray") && n.includes("pagesummary")) s += 45;
  if (n.includes("coach") && n.includes("pagesummary")) s += 45;
  if (n.includes("/pages/") && n.includes("/data/")) s += 20;
  if (n.includes("browsertime")) s += 10;
  if (n.includes("pagexray")) s += 10;
  if (n.includes("coach")) s += 10;
  if (n.includes("lighthouse")) s += 8;
  if (n.includes("axe")) s += 8;
  if (n.includes("sustainable")) s += 8;
  if (n.includes("thirdparty") || n.includes("third-party")) s += 8;
  return s;
}

/**
 * Find and parse browsertime + plugin JSONs from an analysisstorer tree.
 */
export async function loadSitespeedMetrics(
  resultRoot: string,
): Promise<SitespeedMetricsBundle> {
  const bundle = emptySitespeedMetricsBundle();
  const jsonFiles = await walkFiles(resultRoot, (n) => n.endsWith(".json"));
  const ranked = [...jsonFiles].sort((a, b) => pathScore(b) - pathScore(a));

  let gotBt = false;
  let gotLh = false;
  let gotPx = false;
  let gotCoach = false;
  let gotAxe = false;
  let gotSus = false;
  let gotTp = false;

  for (const path of ranked) {
    const lower = path.replace(/\\/g, "/").toLowerCase();
    try {
      const json = await readJsonFile(path);

      if (!gotBt && lower.includes("browsertime")) {
        const { fields, tagged } = extractBrowsertimeFields(json);
        Object.assign(bundle.browsertime, fields);
        bundle.browsertimeTagged.push(...tagged);
        if (Object.keys(fields).length || tagged.length) gotBt = true;
      }
      if (!gotLh && lower.includes("lighthouse")) {
        Object.assign(bundle.lighthouse, extractLighthouseFields(json));
        if (Object.keys(bundle.lighthouse).length) gotLh = true;
      }
      if (!gotPx && lower.includes("pagexray")) {
        const { fields, tagged } = extractPagexrayFields(json);
        Object.assign(bundle.pagexray, fields);
        bundle.pagexrayTagged.push(...tagged);
        if (Object.keys(fields).length || tagged.length) gotPx = true;
      }
      if (!gotCoach && lower.includes("coach")) {
        Object.assign(bundle.coach, extractCoachFields(json));
        if (Object.keys(bundle.coach).length) gotCoach = true;
      }
      if (!gotAxe && (lower.includes("axe") || lower.includes("/axe."))) {
        Object.assign(bundle.axe, extractAxeFields(json));
        if (Object.keys(bundle.axe).length) gotAxe = true;
      }
      if (!gotSus && lower.includes("sustainable")) {
        Object.assign(bundle.sustainable, extractSustainableFields(json));
        if (Object.keys(bundle.sustainable).length) gotSus = true;
      }
      if (
        !gotTp &&
        (lower.includes("thirdparty") || lower.includes("third-party"))
      ) {
        const { fields, tagged } = extractThirdpartyFields(json);
        Object.assign(bundle.thirdparty, fields);
        bundle.thirdpartyTagged.push(...tagged);
        if (Object.keys(fields).length || tagged.length) gotTp = true;
      }
    } catch {
      // skip unreadable / non-json
    }
    if (gotBt && gotLh && gotPx && gotCoach && gotAxe && gotSus && gotTp) break;
  }

  return bundle;
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
