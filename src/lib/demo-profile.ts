/**
 * Pure helpers for demo manager profile PATCH body (unit-testable).
 */

export type DemoProfileBalance = {
  currency?: string;
  value?: number | string;
  current?: boolean;
};

export type DemoProfileLimit = {
  type?: string;
  value?: number;
  time?: number;
  enabled?: boolean;
};

/** Subset of GET /api/v2/profile we care about for PATCH. */
export type DemoProfile = {
  locale?: string;
  timeZoneOffset?: string;
  country?: string;
  gameSettings?: {
    ip?: string;
    limitSettings?: DemoProfileLimit[];
    balance?: DemoProfileBalance[];
  };
};

export type ManagersProfilePatch = {
  locale: string;
  timeZoneOffset: string;
  country: string;
  gameSettings: {
    ip: string;
    limitSettings: Array<{
      value: number;
      type: string;
      enabled: boolean;
      time: number;
    }>;
    balance: Array<{
      currency: string;
      value: string;
      current: boolean;
    }>;
  };
};

export type BuildManagersProfilePatchInput = {
  profile: DemoProfile;
  /** PotatoNetwork emulation country (always applied). */
  country: string;
  /** Optional override; omit to keep profile.locale. */
  locale?: string;
  /** Optional current currency code; omit to keep profile balance.current flags. */
  currency?: string;
};

function balanceValueAsString(value: number | string | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "0";
}

/**
 * Build PATCH /api/v3/managers/profile body from GET /api/v2/profile,
 * forcing `country` to the network-emulation country and optionally
 * overriding locale / current currency.
 */
export function buildManagersProfilePatch(
  input: BuildManagersProfilePatchInput,
): ManagersProfilePatch {
  const gs = input.profile.gameSettings ?? {};
  const locale =
    (input.locale?.trim() || input.profile.locale?.trim() || "EN").toUpperCase();
  const timeZoneOffset =
    input.profile.timeZoneOffset?.trim() || "00:00:00";
  const country = input.country.trim().toUpperCase();
  const ip = gs.ip?.trim() || "0.0.0.0";

  const limitSettings = (gs.limitSettings ?? []).map((l) => ({
    value: typeof l.value === "number" ? l.value : 0,
    type: typeof l.type === "string" ? l.type : "CommonLimit",
    enabled: Boolean(l.enabled),
    time: typeof l.time === "number" ? l.time : 0,
  }));

  const wantCurrency = input.currency?.trim().toUpperCase();
  let balance = (gs.balance ?? []).map((b) => ({
    currency: (b.currency ?? "").toUpperCase(),
    value: balanceValueAsString(b.value),
    current: Boolean(b.current),
  }));

  if (wantCurrency) {
    const has = balance.some((b) => b.currency === wantCurrency);
    if (has) {
      balance = balance.map((b) => ({
        ...b,
        current: b.currency === wantCurrency,
      }));
    } else if (balance.length > 0) {
      // Unknown currency — keep existing currents; caller may log.
      balance = balance.map((b) => ({ ...b }));
    } else {
      balance = [{ currency: wantCurrency, value: "0", current: true }];
    }
  }

  return {
    locale,
    timeZoneOffset,
    country,
    gameSettings: {
      ip,
      limitSettings,
      balance,
    },
  };
}

