import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAINER_URL2GREEN_DATA_DIR,
  URL2GREEN_DOWNLOAD_URL,
  ensureUrl2GreenFile,
  resolveUrl2GreenHostPath,
  sitespeedUrl2GreenBind,
} from "./url2green";

describe("resolveUrl2GreenHostPath", () => {
  test("defaults under SITESPEED_RESULTS_DIR/.url2green", () => {
    expect(resolveUrl2GreenHostPath("/var/lib/potato-sitespeed-results")).toBe(
      "/var/lib/potato-sitespeed-results/.url2green/url2green.json.gz",
    );
  });

  test("env file path used as-is", () => {
    expect(
      resolveUrl2GreenHostPath("/tmp/r", "/data/url2green.json.gz"),
    ).toBe("/data/url2green.json.gz");
  });

  test("env directory gets filename appended", () => {
    expect(resolveUrl2GreenHostPath("/tmp/r", "/data/green")).toBe(
      "/data/green/url2green.json.gz",
    );
  });
});

describe("sitespeedUrl2GreenBind", () => {
  test("bind-mounts parent dir onto sustainable data path", () => {
    expect(
      sitespeedUrl2GreenBind("/host/.url2green/url2green.json.gz"),
    ).toBe(`/host/.url2green:${CONTAINER_URL2GREEN_DATA_DIR}:ro`);
  });
});

describe("ensureUrl2GreenFile", () => {
  test("skips download when file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "url2green-"));
    const gz = join(dir, "url2green.json.gz");
    await writeFile(gz, "existing");
    const fetchImpl = mock(async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    const r = await ensureUrl2GreenFile(gz, { fetchImpl });
    expect(r.downloaded).toBe(false);
    expect(r.path).toBe(gz);
    await rm(dir, { recursive: true, force: true });
  });

  test("downloads when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "url2green-"));
    const gz = join(dir, "url2green.json.gz");
    const payload = Buffer.alloc(2048, 1);
    const fetchImpl = mock(async (input: string | URL) => {
      expect(String(input)).toBe(URL2GREEN_DOWNLOAD_URL);
      return new Response(payload, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await ensureUrl2GreenFile(gz, { fetchImpl });
    expect(r.downloaded).toBe(true);
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(gz)).byteLength).toBe(2048);
    await rm(dir, { recursive: true, force: true });
  });
});
