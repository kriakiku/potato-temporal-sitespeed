import { describe, expect, test } from "bun:test";
import { buildManagersProfilePatch } from "./demo-profile";

const sampleProfile = {
  locale: "EN",
  timeZoneOffset: "04:00:00",
  country: "DE",
  gameSettings: {
    ip: "255.255.255.0",
    limitSettings: [
      { type: "CommonLimit", value: 0, time: 0, enabled: false },
      { type: "TimeLimit", value: 0, time: 0, enabled: false },
    ],
    balance: [
      { currency: "EUR", value: 219.05, current: true },
      { currency: "USD", value: 10, current: false },
    ],
  },
};

describe("buildManagersProfilePatch", () => {
  test("forces emulation country and keeps locale/currency by default", () => {
    const patch = buildManagersProfilePatch({
      profile: sampleProfile,
      country: "BD",
    });
    expect(patch.country).toBe("BD");
    expect(patch.locale).toBe("EN");
    expect(patch.timeZoneOffset).toBe("04:00:00");
    expect(patch.gameSettings.ip).toBe("255.255.255.0");
    expect(patch.gameSettings.balance).toEqual([
      { currency: "EUR", value: "219.05", current: true },
      { currency: "USD", value: "10", current: false },
    ]);
    expect(patch.gameSettings.limitSettings[0]).toEqual({
      value: 0,
      type: "CommonLimit",
      enabled: false,
      time: 0,
    });
  });

  test("optional locale and currency overrides", () => {
    const patch = buildManagersProfilePatch({
      profile: sampleProfile,
      country: "bd",
      locale: "ru",
      currency: "usd",
    });
    expect(patch.country).toBe("BD");
    expect(patch.locale).toBe("RU");
    expect(patch.gameSettings.balance.find((b) => b.current)?.currency).toBe(
      "USD",
    );
    expect(
      patch.gameSettings.balance.find((b) => b.currency === "EUR")?.current,
    ).toBe(false);
  });
});
