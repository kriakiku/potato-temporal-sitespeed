import { describe, expect, test } from "bun:test";
import {
  buildEntryUrl,
  normalizeSiteSpeedInput,
} from "../src/shared/entry-url";
import {
  buildGraphiteNamespace,
  buildResultSlug,
} from "../src/shared/graphite-ns";

describe("buildEntryUrl", () => {
  test("default tld without table", () => {
    expect(
      buildEntryUrl({ tld: "winfinity.live", direct: false }),
    ).toBe("https://winfinity.live/");
  });

  test("with tableId and direct false", () => {
    expect(
      buildEntryUrl({
        tld: "winfinity.live",
        tableId: "t-123",
        direct: false,
      }),
    ).toBe("https://winfinity.live/?tableId=t-123&direct=false");
  });

  test("with tableId and direct true", () => {
    expect(
      buildEntryUrl({
        tld: "stage.winfinity.live",
        tableId: "42",
        direct: true,
      }),
    ).toBe("https://stage.winfinity.live/?tableId=42&direct=true");
  });
});

describe("normalizeSiteSpeedInput", () => {
  test("applies defaults", () => {
    const n = normalizeSiteSpeedInput({
      metricPrefix: "lobby",
      country: "BD",
    });
    expect(n.tld).toBe("winfinity.live");
    expect(n.tier).toBe("typical");
    expect(n.direct).toBe(false);
    expect(n.tableId).toBeUndefined();
    expect(n.iterations).toBe(3);
  });

  test("direct defaults false when tableId set", () => {
    const n = normalizeSiteSpeedInput({
      metricPrefix: "table",
      country: "DE",
      tableId: "abc",
    });
    expect(n.direct).toBe(false);
    expect(n.tableId).toBe("abc");
  });

  test("ignores direct without tableId", () => {
    const n = normalizeSiteSpeedInput({
      metricPrefix: "lobby",
      country: "DE",
      direct: true,
    });
    expect(n.direct).toBe(false);
  });

  test("rejects empty metricPrefix", () => {
    expect(() =>
      normalizeSiteSpeedInput({ metricPrefix: "  ", country: "BD" }),
    ).toThrow();
  });
});

describe("graphite namespace", () => {
  test("joins base and prefix", () => {
    expect(buildGraphiteNamespace("lobby", "sitespeed")).toBe(
      "sitespeed.lobby",
    );
  });

  test("slug sanitizes", () => {
    expect(buildResultSlug("lobby/main")).toBe("lobby-main");
  });
});
