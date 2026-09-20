/**
 * Local e2e: ASS overlay ×6 + FFmpeg burn-in via SITESPEED_IMAGE.
 * No live page URL / browsertime — synthetic mp4 only.
 *
 *   bun run e2e:overlay
 *
 * Optional: SITESPEED_IMAGE, CONTAINER_ENGINE=docker|podman, E2E_OUT=.e2e-out
 */
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildOverlayAss } from "../src/lib/overlay-ass";
import { burnOverlayOntoVideo } from "../src/lib/overlay-ffmpeg";
import {
  OVERLAY_SLOT_LIMIT,
  type OverlayMarker,
  type OverlayTimeline,
} from "../src/lib/overlay-timeline";

function whichEngine(): "docker" | "podman" {
  const prefer = process.env.CONTAINER_ENGINE?.trim();
  if (prefer === "docker" || prefer === "podman") return prefer;
  try {
    const d = Bun.spawnSync(["docker", "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (d.exitCode === 0) return "docker";
  } catch {
    // ignore
  }
  try {
    const p = Bun.spawnSync(["podman", "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode === 0) return "podman";
  } catch {
    // ignore
  }
  throw new Error(
    "Neither docker nor podman is available. Install one to run e2e:overlay.",
  );
}

async function runEngine(
  engine: "docker" | "podman",
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  console.log(`\n$ ${engine} ${args.join(" ")}\n`);
  const proc = Bun.spawn([engine, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function markers(
  role: "ws" | "api",
  n: number,
  t0: number,
  step: number,
  labelPrefix: string,
): OverlayMarker[] {
  const out: OverlayMarker[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      tMs: t0 + i * step,
      role,
      label:
        role === "ws"
          ? `${labelPrefix}/socket${i}`
          : `GET ${labelPrefix}/v1/x${i}`,
    });
  }
  return out;
}

function assertAss(ass: string): void {
  if (!ass.includes("\\pos(12,264)")) {
    throw new Error("ASS missing API block at y=264");
  }
  if (!ass.includes("nav     0.00")) {
    throw new Error("ASS missing nav line");
  }
  if (!ass.includes("iframe  1.23")) {
    throw new Error("ASS missing iframe line");
  }
  if (!ass.includes("api.\\{tld\\}")) {
    throw new Error("ASS missing escaped {tld} scrub");
  }
  // After 7th WS at t=7.00s, sliding window of 6 should drop the first (socket0)
  const lateWs = ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue: 0,0:00:07.00,") && l.includes("ws "));
  if (lateWs.length !== OVERLAY_SLOT_LIMIT) {
    throw new Error(
      `expected ${OVERLAY_SLOT_LIMIT} WS cues at t=7s, got ${lateWs.length}`,
    );
  }
  if (lateWs.some((l) => l.includes("socket0"))) {
    throw new Error("oldest WS (socket0) should have slid out at t=7s");
  }
  if (!lateWs.some((l) => l.includes("socket6"))) {
    throw new Error("newest WS (socket6) missing at t=7s");
  }
}

async function main(): Promise<void> {
  const sitespeedImage =
    process.env.SITESPEED_IMAGE?.trim() ||
    "sitespeedio/sitespeed.io:40.0.0-plus1";
  const outRoot = resolve(process.env.E2E_OUT?.trim() || ".e2e-out");
  const workDir = join(outRoot, `overlay-${Date.now()}`);
  const engine = whichEngine();

  console.log(`Engine: ${engine}`);
  console.log(`Sitespeed image: ${sitespeedImage}`);
  console.log(`Work:   ${workDir}`);

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const ws = markers("ws", 7, 1000, 1000, "api.{tld}");
  const api = markers("api", 7, 1500, 1000, "api.{tld}");
  const timeline: OverlayTimeline = {
    markers: [
      { tMs: 0, role: "nav", label: "nav" },
      { tMs: 1230, role: "iframe", label: "iframe" },
      ...ws,
      ...api,
    ],
    ws,
    api,
    firstIframeMs: 1230,
  };

  const durationMs = 10_000;
  const assPreview = buildOverlayAss(timeline, durationMs);
  assertAss(assPreview);
  await writeFile(join(workDir, "preview.ass"), assPreview, "utf8");
  console.log("ASS assertions OK (slot limit 6, API y=264, scrub)");

  const mp4Name = "chrome.native.mp4";
  const mp4Path = join(workDir, mp4Name);

  const gen = await runEngine(engine, [
    "run",
    "--rm",
    "-v",
    `${workDir}:/data`,
    "--entrypoint",
    "ffmpeg",
    sitespeedImage,
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=1280x720:d=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    `/data/${mp4Name}`,
  ]);
  if (gen.exitCode !== 0) {
    throw new Error(
      `ffmpeg generate failed (${gen.exitCode}): ${(gen.stderr || gen.stdout).slice(-800)}`,
    );
  }

  const burned = await burnOverlayOntoVideo({
    inputMp4: mp4Path,
    workDir,
    timeline,
    sitespeedImage,
    durationMs,
    outputName: "chrome.potato.mp4",
  });

  const overlaySt = await stat(burned.overlayMp4);
  const nativeSt = await stat(mp4Path);
  const assSt = await stat(burned.assPath);
  if (overlaySt.size < 1000) {
    throw new Error(`overlay mp4 too small: ${overlaySt.size}`);
  }
  if (nativeSt.size < 1000) {
    throw new Error(`native mp4 missing/small: ${nativeSt.size}`);
  }
  if (assSt.size < 100) {
    throw new Error(`ASS file too small: ${assSt.size}`);
  }
  if (burned.overlayMp4 === mp4Path) {
    throw new Error("potato overlay must not replace the native mp4");
  }

  console.log("OK overlay e2e", {
    overlayBytes: overlaySt.size,
    nativeBytes: nativeSt.size,
    assBytes: assSt.size,
    potatoMp4: burned.overlayMp4,
    workDir,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
