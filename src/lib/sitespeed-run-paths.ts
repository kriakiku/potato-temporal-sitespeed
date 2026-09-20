/** Disk artifacts for a sitespeed run (engine-host paths under runRoot). */

export const POTATO_METRICS_FILE = "potato-metrics.json";
export const POTATO_ENRICHMENT_FILE = "potato-enrichment.json";
export const POTATO_OVERLAY_RESULT_FILE = "potato-overlay-result.json";
export const POTATO_CPU_METRICS_FILE = "potato-cpu-metrics.json";

export function potatoMetricsPath(runRoot: string): string {
  return `${runRoot}/${POTATO_METRICS_FILE}`;
}

export function potatoEnrichmentPath(runRoot: string): string {
  return `${runRoot}/${POTATO_ENRICHMENT_FILE}`;
}

export function potatoOverlayResultPath(runRoot: string): string {
  return `${runRoot}/${POTATO_OVERLAY_RESULT_FILE}`;
}

export function potatoCpuMetricsPath(runRoot: string): string {
  return `${runRoot}/${POTATO_CPU_METRICS_FILE}`;
}

/** Per-measure-run sitespeed output folder on host / in container. */
export function measureResultsDirName(runIndex: number): string {
  return `results-${runIndex}`;
}

export function measureResultsHostPath(
  runRoot: string,
  runIndex: number,
): string {
  return `${runRoot}/${measureResultsDirName(runIndex)}`;
}

export function measureResultsContainerPath(runIndex: number): string {
  return `/sitespeed.io/${measureResultsDirName(runIndex)}`;
}

export function potatoEnrichmentRunPath(
  runRoot: string,
  runIndex: number,
): string {
  return `${runRoot}/potato-enrichment-${runIndex}.json`;
}

export function potatoMetricsRunPath(runRoot: string, runIndex: number): string {
  return `${runRoot}/potato-metrics-${runIndex}.json`;
}
