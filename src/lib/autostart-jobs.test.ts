import { describe, expect, test, beforeEach } from "bun:test";
import { mkdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clampAutostartIndex,
  loadPotatoConfig,
  parseAutostartJobs,
  parseAutostartState,
  parsePotatoConfig,
  resetPotatoConfigCache,
} from "./autostart-jobs";

describe("parseAutostartJobs / parsePotatoConfig", () => {
  test("accepts config object with autostart array", () => {
    const config = parsePotatoConfig({
      autostart: [
        { metricPrefix: "lobby", country: "BD", tld: "example.com" },
      ],
    });
    expect(config.autostart).toHaveLength(1);
    expect(config.autostart[0]!.metricPrefix).toBe("lobby");
  });

  test("rejects bare array", () => {
    expect(() =>
      parsePotatoConfig([
        { metricPrefix: "lobby", country: "BD", tld: "example.com" },
      ]),
    ).toThrow(/JSON object/);
  });

  test("rejects missing autostart", () => {
    expect(() => parsePotatoConfig({})).toThrow(/autostart is required/);
  });

  test("rejects missing required job fields", () => {
    expect(() => parseAutostartJobs([{ metricPrefix: "x" }])).toThrow(
      /requires metricPrefix/,
    );
  });
});

describe("parseAutostartState / clampAutostartIndex", () => {
  test("defaults and clamps", () => {
    expect(parseAutostartState(null).nextIndex).toBe(0);
    expect(parseAutostartState({ nextIndex: 2.7 }).nextIndex).toBe(2);
    expect(clampAutostartIndex(5, 3)).toBe(2);
    expect(clampAutostartIndex(-1, 3)).toBe(0);
    expect(clampAutostartIndex(0, 0)).toBe(0);
  });
});

describe("loadPotatoConfig hot-reload", () => {
  beforeEach(() => {
    resetPotatoConfigCache();
  });

  test("reloads when mtime changes", async () => {
    const dir = join(tmpdir(), `potato-config-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "config.json");

    await writeFile(
      path,
      JSON.stringify({
        autostart: [
          { metricPrefix: "lobby", country: "BD", tld: "example.com" },
        ],
      }),
      "utf8",
    );
    const first = await loadPotatoConfig(path);
    expect(first?.jobs).toHaveLength(1);
    expect(first?.reloaded).toBe(false);

    const cached = await loadPotatoConfig(path);
    expect(cached?.reloaded).toBe(false);

    await writeFile(
      path,
      JSON.stringify({
        autostart: [
          { metricPrefix: "lobby", country: "BD", tld: "example.com" },
          { metricPrefix: "bj", country: "DE", tld: "example.com" },
        ],
      }),
      "utf8",
    );
    const later = new Date(Date.now() + 2000);
    await utimes(path, later, later);

    const second = await loadPotatoConfig(path);
    expect(second?.reloaded).toBe(true);
    expect(second?.jobs).toHaveLength(2);
    expect(second?.config.autostart[1]!.metricPrefix).toBe("bj");
  });
});
