import { rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildOverlayAss } from "./overlay-ass";
import type { OverlayTimeline } from "./overlay-timeline";
import { podman } from "./podman";

export type BurnOverlayInput = {
  /** Absolute path to source mp4 on engine host */
  inputMp4: string;
  /** Directory visible to both worker and ffmpeg container (parent of input) */
  workDir: string;
  timeline: OverlayTimeline;
  sitespeedImage: string;
  /** Output filename inside workDir; default chrome.potato.mp4 */
  outputName?: string;
  /** Optional duration override (ms); default 3 minutes */
  durationMs?: number;
};

export type BurnOverlayResult = {
  overlayMp4: string;
  assPath: string;
};

/**
 * Probe duration via ffprobe in the sitespeed image; fall back to hint/default.
 */
async function probeDurationMs(
  image: string,
  containerInput: string,
  binds: string[],
): Promise<number | undefined> {
  try {
    const { exitCode, stdout } = await podman.runToCompletion({
      name: `ffprobe-${Date.now()}`,
      image,
      entrypoint: ["ffprobe"],
      cmd: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        containerInput,
      ],
      binds,
    });
    if (exitCode !== 0) return undefined;
    const sec = Number(stdout.trim());
    if (!Number.isFinite(sec) || sec <= 0) return undefined;
    return Math.round(sec * 1000);
  } catch {
    return undefined;
  }
}

/**
 * Burn ASS overlay onto mp4 using ffmpeg from the sitespeed image.
 * Writes a separate output (default `chrome.potato.mp4`); leaves the source intact.
 */
export async function burnOverlayOntoVideo(
  input: BurnOverlayInput,
): Promise<BurnOverlayResult> {
  const workDir = input.workDir;
  const inputName = basename(input.inputMp4);
  const assName = "potato-overlay.ass";
  const outName = input.outputName ?? "chrome.potato.mp4";
  const tmpName = "potato-overlay.tmp.mp4";

  const assHost = join(workDir, assName);
  const outHost = join(workDir, outName);
  const tmpHost = join(workDir, tmpName);

  const binds = [`${workDir}:/data`];
  const containerIn = `/data/${inputName}`;
  const containerAss = `/data/${assName}`;
  const containerTmp = `/data/${tmpName}`;

  let durationMs = input.durationMs;
  if (durationMs === undefined) {
    durationMs = await probeDurationMs(input.sitespeedImage, containerIn, binds);
  }
  if (durationMs === undefined || durationMs < 1000) {
    durationMs = 180_000;
  }

  const ass = buildOverlayAss(input.timeline, durationMs);
  await writeFile(assHost, ass, "utf8");

  console.info(
    JSON.stringify({
      msg: "Burning custom video overlay",
      input: input.inputMp4,
      output: outHost,
      durationMs,
      ws: input.timeline.ws.length,
      api: input.timeline.api.length,
      firstIframeMs: input.timeline.firstIframeMs,
    }),
  );

  const { exitCode, stderr, stdout } = await podman.runToCompletion({
    name: `ffmpeg-overlay-${Date.now()}`,
    image: input.sitespeedImage,
    entrypoint: ["ffmpeg"],
    cmd: [
      "-y",
      "-i",
      containerIn,
      "-vf",
      `ass=${containerAss}`,
      "-c:a",
      "copy",
      containerTmp,
    ],
    binds,
  });

  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg overlay failed (${exitCode}): ${(stderr || stdout).slice(-800)}`,
    );
  }

  await rename(tmpHost, outHost);

  const st = await stat(outHost);
  if (st.size < 1000) {
    throw new Error(`overlay mp4 looks empty (${st.size} bytes)`);
  }

  return {
    overlayMp4: outHost,
    assPath: assHost,
  };
}

/** Resolve work dir as the directory containing the mp4 (must be bind-mountable). */
export function overlayWorkDirFor(mp4Path: string): string {
  return dirname(mp4Path);
}
