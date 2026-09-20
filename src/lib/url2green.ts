/**
 * Local Green Web Foundation domain list for sitespeed sustainable greencheck.
 *
 * Official sitespeed images (40+) omit url2green.json.gz (~87MB) unless built with
 * DOWNLOAD_URL2GREEN=true. Without the file, @tgwf/co2 treats empty `{}` as options
 * and falls through to the greencheckmulti HTTP API.
 *
 * We download the gzipped JSON array once onto the engine host and bind-mount it
 * into the sitespeed container at the path the sustainable plugin expects.
 */
import { mkdir, access, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Upstream dataset used by sitespeed postinstall when DOWNLOAD_URL2GREEN=true. */
export const URL2GREEN_DOWNLOAD_URL =
  "https://raw.githubusercontent.com/sitespeedio/url2green/main/url2green.json.gz";

/** Path inside the sitespeed.io image (sustainable plugin). */
export const CONTAINER_URL2GREEN_DATA_DIR =
  "/usr/src/app/lib/plugins/sustainable/data";

export const URL2GREEN_FILENAME = "url2green.json.gz";

/**
 * Resolve host path for the gzipped url2green file.
 * Env `SITESPEED_URL2GREEN_PATH` may be the .gz file or its parent directory.
 * Default: `{SITESPEED_RESULTS_DIR}/.url2green/url2green.json.gz`.
 */
export function resolveUrl2GreenHostPath(
  sitespeedResultsDir: string,
  envPath?: string,
): string {
  const override = envPath?.trim();
  if (override) {
    if (override.endsWith(".gz") || override.endsWith(URL2GREEN_FILENAME)) {
      return override;
    }
    return join(override, URL2GREEN_FILENAME);
  }
  return join(sitespeedResultsDir, ".url2green", URL2GREEN_FILENAME);
}

/** Host directory to bind-mount onto CONTAINER_URL2GREEN_DATA_DIR. */
export function url2GreenHostDataDir(gzPath: string): string {
  return dirname(gzPath);
}

export function sitespeedUrl2GreenBind(gzPath: string): string {
  return `${url2GreenHostDataDir(gzPath)}:${CONTAINER_URL2GREEN_DATA_DIR}:ro`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure url2green.json.gz exists on the engine host (download once if missing).
 */
export async function ensureUrl2GreenFile(
  gzPath: string,
  opts?: { downloadUrl?: string; fetchImpl?: typeof fetch },
): Promise<{ path: string; downloaded: boolean }> {
  if (await fileExists(gzPath)) {
    return { path: gzPath, downloaded: false };
  }

  const url = opts?.downloadUrl ?? URL2GREEN_DOWNLOAD_URL;
  const fetchFn = opts?.fetchImpl ?? fetch;
  await mkdir(dirname(gzPath), { recursive: true });

  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download url2green (${res.status} ${res.statusText}) from ${url}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(
      `url2green download too small (${buf.byteLength} bytes) from ${url}`,
    );
  }

  const tmp = `${gzPath}.${process.pid}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, gzPath);
  return { path: gzPath, downloaded: true };
}
