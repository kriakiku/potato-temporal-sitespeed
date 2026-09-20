import type {
  PotatoBaseline,
  PotatoProfile,
  PotatoStatsRequest,
  PotatoStatsSnapshot,
} from "../activities/potato";
import {
  scrubHostForMetrics,
  scrubPathForMetrics,
} from "./metric-scrub";
import type { InfluxPoint } from "./influx";
import type {
  SitespeedTimingFields,
  TaggedMetricPoint,
} from "./sitespeed-json";

export type OverlayInfluxMeta = {
  wsMarkers: number;
  apiMarkers: number;
  wsShown: number;
  apiShown: number;
  firstIframeMs: number;
  burned: boolean;
};

function avgLatency(sumMs: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  return sumMs / count;
}

function scrubDomainTag(domain: string, workflowTld: string): string {
  return scrubHostForMetrics(domain, workflowTld);
}

function requestTags(
  base: Record<string, string>,
  req: PotatoStatsRequest,
  workflowTld: string,
): Record<string, string> {
  const out: Record<string, string> = {
    ...base,
    host: scrubHostForMetrics(req.host, workflowTld),
    path: scrubPathForMetrics(req.path),
  };
  if (req.method) out.method = req.method.toUpperCase();
  return out;
}

function latencyFields(
  req: PotatoStatsRequest,
): Record<string, number | undefined> {
  return {
    count: req.count,
    started: req.started,
    errorCount: req.errorCount,
    latencySumMs: req.latencyMs.sumMs,
    latencyMinMs: req.latencyMs.minMs,
    latencyMaxMs: req.latencyMs.maxMs,
    latencyAvgMs: avgLatency(req.latencyMs.sumMs, req.count),
  };
}

export function buildInfluxPoints(input: {
  tags: Record<string, string>;
  workflowTld: string;
  browsertime: SitespeedTimingFields;
  browsertimeTagged?: TaggedMetricPoint[];
  pagexray?: SitespeedTimingFields;
  pagexrayTagged?: TaggedMetricPoint[];
  coach?: SitespeedTimingFields;
  axe?: SitespeedTimingFields;
  lighthouse?: SitespeedTimingFields;
  sustainable?: SitespeedTimingFields;
  thirdparty?: SitespeedTimingFields;
  thirdpartyTagged?: TaggedMetricPoint[];
  profile: PotatoProfile;
  baseline: PotatoBaseline;
  catalogCfRtt?: number;
  catalogNearestAwsRtt?: number;
  nearestAws?: string;
  stats: PotatoStatsSnapshot;
  overlay?: OverlayInfluxMeta;
}): InfluxPoint[] {
  const points: InfluxPoint[] = [];
  const { tags, workflowTld } = input;

  const pushFlat = (
    measurement: string,
    fields: SitespeedTimingFields | undefined,
  ) => {
    if (!fields || Object.keys(fields).length === 0) return;
    points.push({ measurement, tags, fields });
  };

  const pushTagged = (
    measurement: string,
    tagged: TaggedMetricPoint[] | undefined,
  ) => {
    if (!tagged?.length) return;
    for (const p of tagged) {
      if (Object.keys(p.fields).length === 0) continue;
      points.push({
        measurement,
        tags: { ...tags, ...p.tags },
        fields: p.fields,
      });
    }
  };

  pushFlat("potato_browsertime", input.browsertime);
  pushTagged("potato_browsertime", input.browsertimeTagged);
  pushFlat("potato_pagexray", input.pagexray);
  pushTagged("potato_pagexray", input.pagexrayTagged);
  pushFlat("potato_coach", input.coach);
  pushFlat("potato_axe", input.axe);
  pushFlat("potato_lighthouse", input.lighthouse);
  pushFlat("potato_sustainable", input.sustainable);
  pushFlat("potato_thirdparty", input.thirdparty);
  pushTagged("potato_thirdparty", input.thirdpartyTagged);

  const profileFields: Record<string, number | boolean | undefined> = {
    delayMs: input.profile.delayMs,
    downloadMbps: input.profile.downloadMbps,
    uploadMbps: input.profile.uploadMbps,
    lossPercent: input.profile.lossPercent,
    emulationLimited: input.profile.emulationLimited ? true : false,
    passthrough: input.profile.passthrough ? true : false,
    hostCfRttMs: input.baseline.hostRtt?.cf,
    cfRttMs: input.catalogCfRtt,
    nearestAwsRttMs: input.catalogNearestAwsRtt,
  };
  points.push({
    measurement: "potato_profile",
    tags: {
      ...tags,
      ...(input.nearestAws ? { nearestAws: input.nearestAws } : {}),
    },
    fields: profileFields,
  });

  for (const d of input.stats.dns ?? []) {
    points.push({
      measurement: "potato_dns",
      tags: { ...tags, domain: scrubDomainTag(d.domain, workflowTld) },
      fields: {
        count: d.count,
        errorCount: d.errorCount,
        latencySumMs: d.latencyMs.sumMs,
        latencyMinMs: d.latencyMs.minMs,
        latencyMaxMs: d.latencyMs.maxMs,
        latencyAvgMs: avgLatency(d.latencyMs.sumMs, d.count),
      },
    });
  }
  for (const d of input.stats.tlsClient ?? []) {
    points.push({
      measurement: "potato_tls_client",
      tags: { ...tags, domain: scrubDomainTag(d.domain, workflowTld) },
      fields: {
        count: d.count,
        errorCount: d.errorCount,
        latencySumMs: d.latencyMs.sumMs,
        latencyMinMs: d.latencyMs.minMs,
        latencyMaxMs: d.latencyMs.maxMs,
        latencyAvgMs: avgLatency(d.latencyMs.sumMs, d.count),
      },
    });
  }
  for (const d of input.stats.tlsUpstream ?? []) {
    points.push({
      measurement: "potato_tls_upstream",
      tags: { ...tags, domain: scrubDomainTag(d.domain, workflowTld) },
      fields: {
        count: d.count,
        errorCount: d.errorCount,
        latencySumMs: d.latencyMs.sumMs,
        latencyMinMs: d.latencyMs.minMs,
        latencyMaxMs: d.latencyMs.maxMs,
        latencyAvgMs: avgLatency(d.latencyMs.sumMs, d.count),
      },
    });
  }

  for (const req of input.stats.http ?? []) {
    const rtags = requestTags(tags, req, workflowTld);
    points.push({
      measurement: "potato_http",
      tags: rtags,
      fields: latencyFields(req),
    });
    if (req.count > 1) {
      points.push({
        measurement: "potato_http_duplicate",
        tags: rtags,
        fields: {
          count: req.count,
          extraCount: req.count - 1,
          latencySumMs: req.latencyMs.sumMs,
          latencyAvgMs: avgLatency(req.latencyMs.sumMs, req.count),
        },
      });
    }
  }

  for (const req of input.stats.websocket ?? []) {
    points.push({
      measurement: "potato_websocket",
      tags: requestTags(tags, req, workflowTld),
      fields: {
        ...latencyFields(req),
        started: req.started ?? 0,
      },
    });
  }

  const slow = input.stats.slowHTTP ?? [];
  for (let i = 0; i < slow.length; i++) {
    const sample = slow[i]!;
    points.push({
      measurement: "potato_http_slow",
      tags: {
        ...tags,
        rank: String(i + 1),
        host: scrubHostForMetrics(sample.host, workflowTld),
        method: (sample.method || "GET").toUpperCase(),
        path: scrubPathForMetrics(sample.path),
      },
      fields: {
        durationMs: sample.durationMs,
        failed: sample.failed ? true : false,
      },
    });
  }

  const cf = input.stats.cfCache;
  if (cf) {
    const statuses = Object.keys(cf).sort();
    for (const status of statuses) {
      const count = cf[status];
      if (typeof count !== "number" || !Number.isFinite(count)) continue;
      points.push({
        measurement: "potato_cf_cache",
        tags: { ...tags, status },
        fields: { count },
      });
    }
  }

  if (input.overlay) {
    points.push({
      measurement: "potato_overlay",
      tags,
      fields: {
        wsMarkers: input.overlay.wsMarkers,
        apiMarkers: input.overlay.apiMarkers,
        wsShown: input.overlay.wsShown,
        apiShown: input.overlay.apiShown,
        firstIframeMs: input.overlay.firstIframeMs,
        burned: input.overlay.burned ? true : false,
      },
    });
  }

  return points;
}
