import { describe, expect, test } from "bun:test";
import { isPotatoNetworkSidecarName } from "./potato";

describe("isPotatoNetworkSidecarName", () => {
  test("matches long-lived country sidecars and ephemeral leftovers", () => {
    expect(isPotatoNetworkSidecarName("potato-BD-typical")).toBe(true);
    expect(isPotatoNetworkSidecarName("potato-US-slow")).toBe(true);
    expect(
      isPotatoNetworkSidecarName(
        "potato-ss-01a0be94-86d9-7353-a134-8a13ee6db8e5",
      ),
    ).toBe(true);
    expect(isPotatoNetworkSidecarName("potato-refresh-abc")).toBe(true);
  });

  test("never matches the Temporal worker / tooling", () => {
    expect(isPotatoNetworkSidecarName("potato-temporal-sitespeed")).toBe(
      false,
    );
    expect(isPotatoNetworkSidecarName("potato-temporal")).toBe(false);
    expect(isPotatoNetworkSidecarName("potato-temporal-worker")).toBe(false);
  });

  test("rejects unrelated names", () => {
    expect(isPotatoNetworkSidecarName("sitespeed-foo")).toBe(false);
    expect(isPotatoNetworkSidecarName("potato")).toBe(false);
  });
});
