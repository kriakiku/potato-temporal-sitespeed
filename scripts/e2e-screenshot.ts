/**
 * Local e2e: PotatoNetwork + sitespeed (same netns / CA path as prod), then
 * assert the page screenshot is not mostly black.
 *
 * Usage:
 *   SITESPEED_E2E_URL='https://…#masterSessionId=…' bun run e2e:screenshot
 *
 * Optional:
 *   E2E_PLAIN=1              — skip Potato (direct sitespeed)
 *   E2E_COUNTRY=DE           — Potato country profile (omit for passthrough)
 *   E2E_TIER=typical
 *   POTATO_IMAGE=ghcr.io/kriakiku/potato-network:latest
 *   SITESPEED_IMAGE=sitespeedio/sitespeed.io:40.0.0-plus1
 *   E2E_BLACK_THRESHOLD=0.92
 *   E2E_OUT=.e2e-out
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildMeasureJourneyScript } from "../src/lib/bt-measure-journey";
import { buildSitespeedBrowserArgs } from "../src/shared/sitespeed-args";
import { sitespeedPotatoEntrypoint } from "../src/shared/sitespeed-entrypoint";
import {
  analyzeScreenshotBlackness,
  findBestPageScreenshot,
} from "../src/lib/screenshot-blackness";

const DEFAULT_URL =
  "https://blackjack.winfinity.live/?language=en&tableId=6242f678d936cf9808327295&isMultitable=true&streamId=do-bj4&designVersion=1.0&label=winfinity#masterSessionId=bfbe3df9a10e473a92b15f5036138bc9";

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
    "Neither docker nor podman is available. Install one to run e2e:screenshot.",
  );
}

async function runEngine(
  engine: "docker" | "podman",
  args: string[],
  opts?: { inherit?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const inherit = opts?.inherit !== false;
  console.log(`\n$ ${engine} ${args.join(" ")}\n`);
  const proc = Bun.spawn([engine, ...args], {
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  const exitCode = await proc.exited;
  let stdout = "";
  let stderr = "";
  if (!inherit) {
    stdout = await new Response(proc.stdout).text();
    stderr = await new Response(proc.stderr).text();
  }
  return { exitCode, stdout, stderr };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitPotatoHealthy(
  apiBase: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${apiBase}/v1/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (health.ok) {
        const ca = await fetch(`${apiBase}/v1/ca.pem`, {
          signal: AbortSignal.timeout(3000),
        });
        if (ca.ok) {
          const pem = await ca.text();
          if (pem.includes("BEGIN CERTIFICATE")) return;
        }
      }
    } catch {
      // retry
    }
    await sleep(1000);
  }
  throw new Error(`PotatoNetwork not healthy at ${apiBase} within ${timeoutMs}ms`);
}

function inspectPublishedPort(
  engine: "docker" | "podman",
  container: string,
  containerPort: number,
): { host: string; port: number } | null {
  const r = Bun.spawnSync(
    [engine, "port", container, `${containerPort}/tcp`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) return null;
  const text = new TextDecoder().decode(r.stdout).trim();
  // e.g. 127.0.0.1:32768 or 0.0.0.0:32768
  const m = text.match(/([\d.]+):(\d+)/);
  if (!m) return null;
  return {
    host: m[1] === "0.0.0.0" ? "127.0.0.1" : m[1]!,
    port: Number(m[2]),
  };
}

async function main(): Promise<void> {
  const url = process.env.SITESPEED_E2E_URL?.trim() || DEFAULT_URL;
  const sitespeedImage =
    process.env.SITESPEED_IMAGE?.trim() ||
    "sitespeedio/sitespeed.io:40.0.0-plus1";
  const potatoImage =
    process.env.POTATO_IMAGE?.trim() ||
    "ghcr.io/kriakiku/potato-network:latest";
  const threshold = Number(process.env.E2E_BLACK_THRESHOLD ?? "0.92");
  const outDir = resolve(process.env.E2E_OUT?.trim() || ".e2e-out");
  const plain = ["1", "true", "yes"].includes(
    (process.env.E2E_PLAIN ?? "").trim().toLowerCase(),
  );
  const country = process.env.E2E_COUNTRY?.trim();
  const tier = process.env.E2E_TIER?.trim() || "typical";
  const engine = whichEngine();
  const runId = `e2e-${Date.now()}`;
  const potatoName = `potato-${runId}`;
  const volumeName = `potato-e2e-data-${runId}`;

  console.log(`Engine: ${engine}`);
  console.log(`Mode:   ${plain ? "plain (no Potato)" : "PotatoNetwork netns"}`);
  console.log(`Sitespeed image: ${sitespeedImage}`);
  if (!plain) {
    console.log(`Potato image:    ${potatoImage}`);
    console.log(
      `Potato profile:  ${country ? `${country}/${tier}` : "passthrough"}`,
    );
  }
  console.log(`URL:    ${url.slice(0, 80)}${url.length > 80 ? "…" : ""}`);
  console.log(`Out:    ${outDir}`);
  console.log(`Black threshold: ${threshold}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await writeFile(
    join(outDir, "bt-measure-journey.js"),
    buildMeasureJourneyScript({
      url,
      alias: "e2e",
    }),
    "utf8",
  );

  const args = buildSitespeedBrowserArgs({
    browser: "chrome",
    slug: "e2e-screenshot",
    metricPrefix: "e2e",
    cacheMode: "cold",
    url,
    outputFolder: "/sitespeed.io/results",
    multiScriptPath: "/sitespeed.io/bt-measure-journey.js",
    removeLighthouse: true,
    removeGpsi: true,
  });

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

  let potatoStarted = false;

  try {
    if (!plain) {
      await runEngine(engine, ["volume", "create", volumeName]);

      const potatoEnv = [
        "-e",
        "POTATONETWORK_CATALOG_CRON=false",
        "-e",
        "POTATONETWORK_BASELINE_CRON=false",
      ];
      if (country) {
        potatoEnv.push(
          "-e",
          `POTATONETWORK_PROFILE_COUNTRY=${country}`,
          "-e",
          `POTATONETWORK_PROFILE_TIER=${tier}`,
        );
      }

      await runEngine(engine, [
        "run",
        "-d",
        "--name",
        potatoName,
        "--cap-add=NET_ADMIN",
        "-p",
        "127.0.0.1::7783",
        "-v",
        `${volumeName}:/data`,
        ...potatoEnv,
        potatoImage,
      ]);
      potatoStarted = true;

      let binding: { host: string; port: number } | null = null;
      for (let i = 0; i < 40; i++) {
        binding = inspectPublishedPort(engine, potatoName, 7783);
        if (binding) break;
        await sleep(500);
      }
      if (!binding) {
        throw new Error(`Timed out waiting for Potato port 7783 on ${potatoName}`);
      }
      const apiBase = `http://${binding.host}:${binding.port}`;
      console.log(`Potato API: ${apiBase}`);
      await waitPotatoHealthy(apiBase);
      console.log("Potato healthy + CA ready");
    }

    const containerArgs: string[] = ["run", "--rm", "--shm-size=2g"];

    if (!plain) {
      const { entrypoint, cmd: wrapped } =
        sitespeedPotatoEntrypoint(sitespeedCmd);
      containerArgs.push(
        `--network=container:${potatoName}`,
        "-v",
        `${outDir}:/sitespeed.io`,
        "-v",
        `${volumeName}:/potato-data:ro`,
        "-e",
        "NODE_EXTRA_CA_CERTS=/potato-data/ca/potatonetwork-ca.pem",
        "--entrypoint",
        entrypoint[0]!,
        sitespeedImage,
        ...entrypoint.slice(1),
        ...wrapped,
      );
    } else {
      containerArgs.push(
        "-v",
        `${outDir}:/sitespeed.io`,
        sitespeedImage,
        ...sitespeedCmd,
      );
    }

    const { exitCode } = await runEngine(engine, containerArgs);
    if (exitCode !== 0) {
      console.error(`sitespeed container exited with code ${exitCode}`);
      process.exit(exitCode || 1);
    }
  } finally {
    if (potatoStarted) {
      await runEngine(engine, ["rm", "-f", potatoName], { inherit: true });
      await runEngine(engine, ["volume", "rm", "-f", volumeName], {
        inherit: true,
      });
    }
  }

  const pngPath = await findBestPageScreenshot(outDir);
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
      plain
        ? "\nFAIL: screenshot is mostly black (plain mode — capture/session/WebGL)."
        : "\nFAIL: screenshot is mostly black through PotatoNetwork (MITM/cert/shaping or blank page).",
    );
    process.exit(1);
  }

  console.log(
    plain
      ? "\nPASS: screenshot has enough non-black pixels (plain)."
      : "\nPASS: screenshot has enough non-black pixels through PotatoNetwork.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
