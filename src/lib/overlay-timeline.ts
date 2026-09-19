import {
  scrubHostForMetrics,
  scrubPathForMetrics,
} from "./metric-scrub";

/** Sliding window size for WS and API lines on the video overlay. */
export const OVERLAY_SLOT_LIMIT = 6;

export type OverlayEventIn = {
  kind: string;
  host: string;
  method?: string;
  path: string;
  atUnixMs: number;
};

export type OverlayMarker = {
  /** ms since navigation (video t=0) */
  tMs: number;
  role: "nav" | "iframe" | "ws" | "api";
  label: string;
};

export type OverlayTimeline = {
  markers: OverlayMarker[];
  /** All WS markers (ASS sliding window uses last OVERLAY_SLOT_LIMIT) */
  ws: OverlayMarker[];
  /** All non-static API markers */
  api: OverlayMarker[];
  firstIframeMs: number;
  videoDurationHintMs?: number;
};

const STATIC_EXT =
  /\.(js|mjs|cjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|avif|wasm)(\?|$)/i;

export function isStaticAssetPath(path: string): boolean {
  const p = path.split(/[?#]/)[0] ?? path;
  return STATIC_EXT.test(p);
}

export function lastN<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  return items.length <= n ? [...items] : items.slice(items.length - n);
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Build overlay timeline aligned to navigation (video t≈0).
 * Anchor = earliest http_start whose host matches the measured page host.
 */
export function buildOverlayTimeline(input: {
  events: OverlayEventIn[];
  pageUrl: string;
  workflowTld: string;
  firstIframeMs?: number;
}): OverlayTimeline {
  const pageHost = hostOfUrl(input.pageUrl);
  const events = [...input.events].sort((a, b) => a.atUnixMs - b.atUnixMs);

  let anchor = events.find(
    (e) =>
      e.kind === "http_start" &&
      pageHost &&
      e.host.toLowerCase() === pageHost,
  );
  if (!anchor) {
    anchor = events.find((e) => e.kind === "http_start");
  }
  const anchorMs = anchor?.atUnixMs ?? events[0]?.atUnixMs ?? Date.now();

  const offset = (at: number) => Math.max(0, at - anchorMs);

  const markers: OverlayMarker[] = [
    { tMs: 0, role: "nav", label: "nav" },
  ];

  const iframeMs =
    typeof input.firstIframeMs === "number" && input.firstIframeMs >= 0
      ? input.firstIframeMs
      : -1;
  if (iframeMs >= 0) {
    markers.push({
      tMs: Math.round(iframeMs),
      role: "iframe",
      label: "iframe",
    });
  }

  const wsAll: OverlayMarker[] = [];
  const apiAll: OverlayMarker[] = [];

  for (const ev of events) {
    const tMs = offset(ev.atUnixMs);
    const host = scrubHostForMetrics(ev.host, input.workflowTld);
    const path = scrubPathForMetrics(ev.path);
    if (ev.kind === "ws_start") {
      wsAll.push({
        tMs,
        role: "ws",
        label: `${host}${path}`,
      });
    } else if (
      ev.kind === "http_start" &&
      !isStaticAssetPath(ev.path) &&
      // Document navigation is the timeline anchor — not an API marker
      ev !== anchor
    ) {
      const method = (ev.method || "GET").toUpperCase();
      apiAll.push({
        tMs,
        role: "api",
        label: `${method} ${host}${path}`,
      });
    }
  }

  // Keep full lists for ASS sliding windows; Telegraf can lastN(OVERLAY_SLOT_LIMIT) separately.
  markers.push(...wsAll, ...apiAll);
  markers.sort((a, b) => a.tMs - b.tMs || a.role.localeCompare(b.role));

  return {
    markers,
    ws: wsAll,
    api: apiAll,
    firstIframeMs: iframeMs,
  };
}
