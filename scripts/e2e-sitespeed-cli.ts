/**
 * CI smoke: stage journey + first-iframe like production, run the real
 * sitespeed.io image with buildSitespeedBrowserArgs (incl. --multi).
 * No Potato, no live session — catches startsWith / missing-script regressions.
 * Default URL includes a `#…` fragment (auth-style hash, not SPA routing) so we
 * verify the journey keeps the fragment intact through JSON embedding + driver.get.
 *
 *   bun run e2e:sitespeed-cli
 *
 * Optional: SITESPEED_IMAGE, CONTAINER_ENGINE=docker|podman, E2E_OUT=.e2e-cli-out
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMeasureJourneyScript } from "../src/lib/bt-measure-journey";
import { buildSitespeedBrowserArgs } from "../src/shared/sitespeed-args";

/** Docs page + synthetic auth hash — must survive into bt-measure-journey.js. */
const DEFAULT_URL =
  "https://kriakiku.github.io/potato-network/#masterSessionId=e2e-ci-hash-check";
const DEFAULT_IMAGE = "sitespeedio/sitespeed.io:40.0.0-plus1";
const HOST_FIRST_IFRAME = fileURLToPath(
  new URL("./bt-first-iframe.js", import.meta.url),
);

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
    "Neither docker nor podman is available. Install one to run e2e:sitespeed-cli.",
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

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const engine = whichEngine();
  const sitespeedImage =
    process.env.SITESPEED_IMAGE?.trim() || DEFAULT_IMAGE;
  const url = process.env.SITESPEED_E2E_URL?.trim() || DEFAULT_URL;
  const outDir = resolve(process.env.E2E_OUT?.trim() || ".e2e-cli-out");

  console.log(`Engine:  ${engine}`);
  console.log(`Image:   ${sitespeedImage}`);
  console.log(`URL:     ${url}`);
  console.log(`Out:     ${outDir}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await copyFile(HOST_FIRST_IFRAME, join(outDir, "bt-first-iframe.js"));
  const journeyPath = join(outDir, "bt-measure-journey.js");
  await writeFile(
    journeyPath,
    buildMeasureJourneyScript({
      url,
      alias: "ci",
    }),
    "utf8",
  );

  // Hash fragments must remain in the staged journey (JSON.stringify + driver.get).
  const journeySrc = await readFile(journeyPath, "utf8");
  if (!url.includes("#")) {
    fail(
      `e2e URL must include a #hash fragment to guard auth-style URLs (got: ${url})`,
    );
  }
  const hashPart = url.slice(url.indexOf("#"));
  if (!journeySrc.includes(JSON.stringify(url))) {
    fail(
      `journey script lost full URL with hash (expected JSON ${JSON.stringify(url)})`,
    );
  }
  if (!journeySrc.includes(hashPart)) {
    fail(`journey script missing hash fragment ${hashPart}`);
  }
  console.log(`Hash OK: journey embeds ${hashPart}`);

  const args = buildSitespeedBrowserArgs({
    browser: "chrome",
    slug: "e2e-cli",
    metricPrefix: "ci",
    cacheMode: "cold",
    url,
    outputFolder: "/sitespeed.io/results",
    scriptPath: "/sitespeed.io/bt-first-iframe.js",
    multiScriptPath: "/sitespeed.io/bt-measure-journey.js",
    removeLighthouse: true,
    removeGpsi: true,
    video: false,
    clearCache: true,
  });

  // Slim CI flags: drop CPU/axe/sustainable (still exercises --multi + journey + cacheClearRaw)
  const slim = args.filter(
    (a) =>
      a !== "--cpu" &&
      a !== "--sustainable.enable" &&
      a !== "--axe.enable",
  );
  if (!slim.includes("--multi")) {
    fail("buildSitespeedBrowserArgs must include --multi for journey scripts");
  }
  if (!slim.includes("--browsertime.cacheClearRaw=true")) {
    fail("cold journey must pass --browsertime.cacheClearRaw=true (bare flag swallows the script path)");
  }
  if (slim.at(-1) !== "/sitespeed.io/bt-measure-journey.js") {
    fail("journey script must be the last CLI argument");
  }

  const pull = await runEngine(engine, ["pull", sitespeedImage]);
  if (pull.exitCode !== 0) {
    console.error(pull.stderr || pull.stdout);
    fail(`failed to pull ${sitespeedImage}`);
  }

  const { exitCode, stdout, stderr } = await runEngine(engine, [
    "run",
    "--rm",
    "--shm-size=2g",
    "-v",
    `${outDir}:/sitespeed.io`,
    sitespeedImage,
    ...slim,
  ]);

  const combined = `${stderr}\n${stdout}`;
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (/Cannot read properties of undefined \(reading 'startsWith'\)/i.test(combined)) {
    fail("sitespeed crashed on url.startsWith (missing --multi / empty getURLs?)");
  }
  if (
    /Cannot find module|ENOENT.*bt-measure-journey|does not exist.*bt-measure-journey/i.test(
      combined,
    )
  ) {
    fail("journey script missing inside container bind mount");
  }
  if (exitCode !== 0) {
    fail(`sitespeed exited with code ${exitCode}`);
  }
  if (!/Start to measure/i.test(combined)) {
    fail("expected browsertime 'Start to measure' in logs (journey did not run)");
  }

  console.log("\nPASS: sitespeed CLI journey smoke OK\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
