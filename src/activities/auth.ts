import { optional, required } from "../lib/env";
import { generateTotpCode } from "../lib/totp";

export type ResolveEntryUrlInput = {
  tld: string;
  tableId?: string;
  /** When tableId is set: open game frame without lobby via enter-table */
  direct: boolean;
};

export type ResolveEntryUrlResult = {
  frameUrl: string;
  msid: string;
  mode: "lobby" | "lobby-table" | "direct-table";
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

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      ...headers,
    },
    body: JSON.stringify(body),
  });

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

  return json as T;
}

/**
 * Authenticate against demo.{tld}, start a master session, and optionally
 * enter a table directly. Returns the frameUrl sitespeed should open.
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
  const identifier = required("DEMO_AUTH_IDENTIFIER");
  const password = required("DEMO_AUTH_PASSWORD");
  const authenticator = optional("DEMO_AUTH_AUTHENTICATOR");
  const tld = input.tld.replace(/^https?:\/\//, "").replace(/\/$/, "");

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

  const startBody: { extend: true; tableId?: string } = { extend: true };
  if (input.tableId) {
    startBody.tableId = input.tableId;
  }

  const session = await postJson<MasterSessionResponse>(
    `https://demo.${tld}/api/go/v1/master-sessions/start`,
    startBody,
    { authorization: `Bearer ${accessToken}` },
  );

  const msid = session.msid;
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
