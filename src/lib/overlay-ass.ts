import type { OverlayMarker, OverlayTimeline } from "./overlay-timeline";
import { OVERLAY_SLOT_LIMIT } from "./overlay-timeline";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ASS timestamp h:mm:ss.cc (centiseconds). */
export function formatAssTime(ms: number): string {
  if (ms < 0) ms = 0;
  const totalCs = Math.round(ms / 10);
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function escAss(text: string): string {
  return text.replace(/[{}\\]/g, "\\$&").replace(/\n/g, "\\N");
}

/**
 * Encode a sliding last-N window: at each new marker, redraw up to `limit`
 * lines until the next marker (or video end). Oldest drops when a (limit+1)th arrives.
 */
export function slidingSlotCues(
  markers: OverlayMarker[],
  limit: number,
  videoEndMs: number,
  linePrefix: string,
  y0: number,
  yStep: number,
): string[] {
  const lines: string[] = [];
  if (markers.length === 0 || limit <= 0) return lines;

  for (let i = 0; i < markers.length; i++) {
    const startMs = markers[i]!.tMs;
    const endMs = i + 1 < markers.length ? markers[i + 1]!.tMs : videoEndMs;
    if (endMs <= startMs) continue;
    const visible = markers.slice(Math.max(0, i + 1 - limit), i + 1);
    for (let slot = 0; slot < visible.length; slot++) {
      const m = visible[slot]!;
      const y = y0 + slot * yStep;
      const text = `${linePrefix} ${fmtSec(m.tMs)}  ${m.label}`;
      lines.push(
        `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Default,,0,0,0,,{\\an7\\pos(12,${y})}${escAss(text)}`,
      );
    }
  }
  return lines;
}

const WS_Y0 = 96;
const LINE_STEP = 28;
/** API block starts below 6 WS lines: 96 + 6*28 = 264 */
const API_Y0 = WS_Y0 + OVERLAY_SLOT_LIMIT * LINE_STEP;

/**
 * Build ASS with running timer, nav/iframe lines, sliding WS×6 and API×6.
 */
export function buildOverlayAss(
  timeline: OverlayTimeline,
  videoDurationMs: number,
): string {
  const end = Math.max(videoDurationMs, 1000);
  const header = `[Script Info]
Title: potato overlay
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans Mono,22,&H00FFFFFF,&H000000FF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,8,8,8,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogues: string[] = [];

  for (let t = 0; t < end; t += 1000) {
    const tEnd = Math.min(t + 1000, end);
    dialogues.push(
      `Dialogue: 0,${formatAssTime(t)},${formatAssTime(tEnd)},Default,,0,0,0,,{\\an7\\pos(12,12)}${escAss(`t  ${fmtSec(t)}s`)}`,
    );
  }

  dialogues.push(
    `Dialogue: 0,${formatAssTime(0)},${formatAssTime(end)},Default,,0,0,0,,{\\an7\\pos(12,40)}${escAss(`nav     ${fmtSec(0)}`)}`,
  );

  const iframe = timeline.markers.find((m) => m.role === "iframe");
  if (iframe) {
    dialogues.push(
      `Dialogue: 0,${formatAssTime(iframe.tMs)},${formatAssTime(end)},Default,,0,0,0,,{\\an7\\pos(12,68)}${escAss(`iframe  ${fmtSec(iframe.tMs)}`)}`,
    );
  }

  dialogues.push(
    ...slidingSlotCues(
      timeline.ws,
      OVERLAY_SLOT_LIMIT,
      end,
      "ws ",
      WS_Y0,
      LINE_STEP,
    ),
    ...slidingSlotCues(
      timeline.api,
      OVERLAY_SLOT_LIMIT,
      end,
      "api",
      API_Y0,
      LINE_STEP,
    ),
  );

  return header + dialogues.join("\n") + "\n";
}
