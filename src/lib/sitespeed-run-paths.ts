/** Disk artifacts for a sitespeed run (engine-host paths under runRoot). */

export const POTATO_METRICS_FILE = "potato-metrics.json";
export const POTATO_ENRICHMENT_FILE = "potato-enrichment.json";
export const POTATO_OVERLAY_RESULT_FILE = "potato-overlay-result.json";

export function potatoMetricsPath(runRoot: string): string {
  return `${runRoot}/${POTATO_METRICS_FILE}`;
}

export function potatoEnrichmentPath(runRoot: string): string {
  return `${runRoot}/${POTATO_ENRICHMENT_FILE}`;
}

export function potatoOverlayResultPath(runRoot: string): string {
  return `${runRoot}/${POTATO_OVERLAY_RESULT_FILE}`;
}
