import { log } from "@temporalio/activity";
import {
  buildManagersProfilePatch,
  type DemoProfile,
} from "../lib/demo-profile";
import { optional, required } from "../lib/env";
import { generateTotpCode } from "../lib/totp";

export type ResolveEntryUrlInput = {
  tld: string;
  tableId?: string;
  /** When tableId is set: open game frame without lobby via enter-table */
  direct: boolean;
  /** PotatoNetwork emulation country — written to demo manager profile. */
  country: string;
  /** Optional locale override for manager profile (e.g. EN). */
  locale?: string;
  /** Optional current currency override (e.g. EUR). */
  currency?: string;
};

export type ResolveEntryUrlResult = {
  frameUrl: string;
  msid: string;
  mode: "lobby" | "lobby-table" | "direct-table";
};

export type DeleteMasterSessionInput = {
  tld: string;
  msid: string;
};

type AuthTokenResponse = {
  tokenData?: {
    accessToken?: string;
    expiresIn?: number;
    refreshToken?: string;
  };
};

type MasterSessionResponse = {
  frameUrl?: string;
  msid?: string;
};

type EnterTableResponse = {
  frameUrl?: string;
  siteId?: string;
  tableName?: string;
};

type AuthTokenBody = {
  password: string;
  identifier: string;
  extra?: { code: string };
};

function normalizeTld(tld: string): string {
  return tld.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function parseJsonResponse(
  url: string,
  res: Response,
): Promise<unknown> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(
      `${url} returned non-JSON (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `${url} failed (${res.status}): ${text.slice(0, 800)}`,
    );
  }
  return json;
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      accept: "application/json, text/plain, */*",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return (await parseJsonResponse(url, res)) as T;
}

async function getJson<T>(
  url: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      ...headers,
    },
  });
  return (await parseJsonResponse(url, res)) as T;
}

async function patchJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      accept: "application/json, text/plain, */*",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return (await parseJsonResponse(url, res)) as T;
}

async function fetchDemoAccessToken(tld: string): Promise<string> {
  const identifier = required("DEMO_AUTH_IDENTIFIER");
  const password = required("DEMO_AUTH_PASSWORD");
  const authenticator = optional("DEMO_AUTH_AUTHENTICATOR");

  const authBody: AuthTokenBody = { password, identifier };
  if (authenticator) {
    authBody.extra = { code: generateTotpCode(authenticator) };
  }

  const auth = await postJson<AuthTokenResponse>(
    `https://demo.${tld}/api/v2/auth/token`,
    authBody,
  );

  const accessToken = auth.tokenData?.accessToken;
  if (!accessToken) {
    throw new Error("auth/token response missing tokenData.accessToken");
  }
  return accessToken;
}

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

/**
 * Sync demo manager profile country (and optional locale/currency) to match
 * the PotatoNetwork emulation before opening a master session.
 */
async function syncManagersProfile(opts: {
  tld: string;
  accessToken: string;
  country: string;
  locale?: string;
  currency?: string;
}): Promise<void> {
  const profile = await getJson<DemoProfile>(
    `https://demo.${opts.tld}/api/v2/profile`,
    bearer(opts.accessToken),
  );

  if (
    opts.currency &&
    !(profile.gameSettings?.balance ?? []).some(
      (b) =>
        (b.currency ?? "").toUpperCase() === opts.currency!.trim().toUpperCase(),
    )
  ) {
    log.warn("Requested currency not in profile balance; leaving currents", {
      currency: opts.currency,
    });
  }

  const patch = buildManagersProfilePatch({
    profile,
    country: opts.country,
    locale: opts.locale,
    currency: opts.currency,
  });

  await patchJson(
    `https://demo.${opts.tld}/api/v3/managers/profile`,
    patch,
    bearer(opts.accessToken),
  );
  log.info("Synced demo managers profile", {
    country: patch.country,
    locale: patch.locale,
    currency: patch.gameSettings.balance.find((b) => b.current)?.currency,
  });
}

/**
 * Start a plain lobby master session, read msid/mid, bulk-delete it.
 * Ensures any prior/current session is cleared before we create the real one.
 */
async function discardLobbyMasterSession(opts: {
  tld: string;
  accessToken: string;
}): Promise<void> {
  const startUrl = `https://demo.${opts.tld}/api/go/v1/master-sessions/start`;
  const session = await postJson<MasterSessionResponse>(
    startUrl,
    { extend: true },
    bearer(opts.accessToken),
  );
  const msid = session.msid?.trim();
  if (!msid) {
    log.warn("Lobby master-sessions/start returned no msid; skip pre-delete");
    return;
  }

  await postJson(
    `https://demo.${opts.tld}/api/go/v1/master-sessions/bulk-delete`,
    { masterSessionIds: [msid] },
    bearer(opts.accessToken),
  );
  log.info("Deleted lobby master session before create", { msid });
}

/**
 * Authenticate against demo.{tld}, sync manager profile to emulation country,
 * discard the current lobby master session, start a fresh one, optionally enter-table.
 *
 * Modes:
 * - no tableId → lobby frameUrl from master-sessions/start
 * - tableId, direct=false → lobby+table frameUrl from master-sessions/start
 * - tableId, direct=true (default) → game frameUrl from lobby enter-table
 *
 * When `DEMO_AUTH_AUTHENTICATOR` is set (base32 TOTP secret), the auth/token
 * body includes `extra: { code }` from the current authenticator code.
 */
export async function resolveEntryUrl(
  input: ResolveEntryUrlInput,
): Promise<ResolveEntryUrlResult> {
  const tld = normalizeTld(input.tld);
  const accessToken = await fetchDemoAccessToken(tld);

  await syncManagersProfile({
    tld,
    accessToken,
    country: input.country,
    locale: input.locale,
    currency: input.currency,
  });

  await discardLobbyMasterSession({ tld, accessToken });

  const startBody: { extend: true; tableId?: string } = { extend: true };
  if (input.tableId) {
    startBody.tableId = input.tableId;
  }

  const session = await postJson<MasterSessionResponse>(
    `https://demo.${tld}/api/go/v1/master-sessions/start`,
    startBody,
    bearer(accessToken),
  );

  const msid = session.msid?.trim();
  if (!msid) {
    throw new Error("master-sessions/start response missing msid");
  }

  if (input.direct && input.tableId) {
    const entered = await postJson<EnterTableResponse>(
      `https://lobby.${tld}/api/v1/enter-table`,
      { sessionId: msid, tableId: input.tableId },
    );
    if (!entered.frameUrl) {
      throw new Error("enter-table response missing frameUrl");
    }
    return {
      frameUrl: normalizeFrameUrl(entered.frameUrl),
      msid,
      mode: "direct-table",
    };
  }

  if (!session.frameUrl) {
    throw new Error("master-sessions/start response missing frameUrl");
  }

  return {
    frameUrl: normalizeFrameUrl(session.frameUrl),
    msid,
    mode: input.tableId ? "lobby-table" : "lobby",
  };
}

/**
 * Best-effort cleanup of a demo master session created by resolveEntryUrl.
 * Re-authenticates (token from start may have expired on long sitespeed runs).
 */
export async function deleteMasterSession(
  input: DeleteMasterSessionInput,
): Promise<void> {
  const tld = normalizeTld(input.tld);
  const msid = input.msid.trim();
  if (!msid) return;

  try {
    const accessToken = await fetchDemoAccessToken(tld);
    await postJson(
      `https://demo.${tld}/api/go/v1/master-sessions/bulk-delete`,
      { masterSessionIds: [msid] },
      bearer(accessToken),
    );
    log.info("Deleted demo master session", { tld, msid });
  } catch (err) {
    log.warn("Failed to delete demo master session", {
      tld,
      msid,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Drop redundant `:443` on https URLs (enter-table sometimes includes it). */
export function normalizeFrameUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && u.port === "443") {
      u.port = "";
    }
    return u.toString();
  } catch {
    return url;
  }
}
