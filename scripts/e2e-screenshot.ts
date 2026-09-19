/**
 * Local e2e: run sitespeed (Docker/Podman) with the same browser flags as prod,
 * then fail if the largest screenshot PNG is mostly black.
 *
 * Usage:
 *   SITESPEED_E2E_URL='https://…#masterSessionId=…' bun run e2e:screenshot
 *
 * Optional:
 *   SITESPEED_IMAGE=sitespeedio/sitespeed.io:40.0.0-plus1
 *   E2E_BLACK_THRESHOLD=0.92
 *   E2E_OUT=.e2e-out
 */
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { buildSitespeedBrowserArgs } from "../src/shared/sitespeed-args";
import {
  analyzeScreenshotBlackness,
  findLargestPng,
} from "../src/lib/screenshot-blackness";

const DEFAULT_URL =
  "https://blackjack.winfinity.live/?language=en&tableId=6242f678d936cf9808327295&isMultitable=true&streamId=do-bj4&designVersion=1.0&label=winfinity#masterSessionId=bfbe3df9a10e473a92b15f5036138bc9";

function whichEngine(): "docker" | "podman" {
  const prefer = process.env.CONTAINER_ENGINE?.trim();
  if (prefer === "docker" || prefer === "podman") return prefer;
  // Prefer docker when both exist
  try {
    const d = Bun.spawnSync(["docker", "version"], { stdout: "pipe", stderr: "pipe" });
    if (d.exitCode === 0) return "docker";
  } catch {
    // ignore
  }
  try {
    const p = Bun.spawnSync(["podman", "version"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0) return "podman";
  } catch {
    // ignore
  }
  throw new Error(
    "Neither docker nor podman is available. Install one to run e2e:screenshot.",
  );
}

async function main(): Promise<void> {
  const url = process.env.SITESPEED_E2E_URL?.trim() || DEFAULT_URL;
  const image =
    process.env.SITESPEED_IMAGE?.trim() ||
    "sitespeedio/sitespeed.io:40.0.0-plus1";
  const threshold = Number(process.env.E2E_BLACK_THRESHOLD ?? "0.92");
  const outDir = resolve(process.env.E2E_OUT?.trim() || ".e2e-out");
  const engine = whichEngine();

  console.log(`Engine: ${engine}`);
  console.log(`Image:  ${image}`);
  console.log(`URL:    ${url.slice(0, 80)}${url.length > 80 ? "…" : ""}`);
  console.log(`Out:    ${outDir}`);
  console.log(`Black threshold: ${threshold}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const args = buildSitespeedBrowserArgs({
    browser: "chrome",
    iterations: 1,
    slug: "e2e-screenshot",
    metricPrefix: "e2e",
    cacheMode: "cold",
    url,
    removeLighthouse: true,
    removeGpsi: true,
  });

  // Keep video off for faster e2e; force a screenshot for blackness check
  const sitespeedCmd = [
    ...args.slice(0, -1),
    "--video",
    "false",
    "--visualMetrics",
    "false",
    "--screenshot",
    "true",
    args.at(-1)!,
  ];

  const containerArgs = [
    "run",
    "--rm",
    "--shm-size=2g",
    "-v",
    `${outDir}:/sitespeed.io`,
    image,
    ...sitespeedCmd,
  ];

  console.log(`\n$ ${engine} ${containerArgs.join(" ")}\n`);

  const proc = Bun.spawn([engine, ...containerArgs], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`sitespeed container exited with code ${exitCode}`);
    process.exit(exitCode || 1);
  }

  const pngPath = await findLargestPng(outDir);
  if (!pngPath) {
    console.error(`No PNG screenshots found under ${outDir}`);
    process.exit(1);
  }

  const result = await analyzeScreenshotBlackness(pngPath);
  console.log("\nScreenshot blackness:");
  console.log(`  path:   ${result.path}`);
  console.log(`  size:   ${result.width}x${result.height}`);
  console.log(
    `  black:  ${(result.blackRatio * 100).toFixed(1)}% (${result.blackPixels}/${result.totalPixels})`,
  );
  console.log(`  limit:  ${(threshold * 100).toFixed(1)}%`);

  if (result.blackRatio >= threshold) {
    console.error(
      "\nFAIL: screenshot is mostly black. Without Potato this usually means Chrome/Xvfb did not capture page pixels (blank load, WebGL/canvas stream, or session expired).",
    );
    process.exit(1);
  }

  console.log("\nPASS: screenshot has enough non-black pixels.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
