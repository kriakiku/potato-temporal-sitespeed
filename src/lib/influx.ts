export type InfluxTags = Record<string, string | boolean | number | undefined>;
export type InfluxFields = Record<
  string,
  number | string | boolean | undefined | null
>;

export type InfluxPoint = {
  measurement: string;
  tags?: InfluxTags;
  fields: InfluxFields;
  /** Unix nanoseconds; default now */
  timestampNs?: bigint;
};

export type InfluxWriteAuth = {
  username?: string;
  password?: string;
  /** Bearer token; takes precedence over Basic when set. */
  token?: string;
};

function escapeTagValue(v: string): string {
  return v.replace(/[,\s=]/g, (c) => `\\${c}`);
}

function escapeFieldString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatTags(tags: InfluxTags | undefined): string {
  if (!tags) return "";
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(tags)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const v =
      typeof raw === "boolean" || typeof raw === "number" ? String(raw) : raw;
    parts.push(`${escapeTagValue(k)}=${escapeTagValue(v)}`);
  }
  return parts.length ? `,${parts.join(",")}` : "";
}

function formatFields(fields: InfluxFields): string {
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(fields)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "boolean") {
      parts.push(`${k}=${raw ? "t" : "f"}`);
    } else if (typeof raw === "number") {
      if (!Number.isFinite(raw)) continue;
      parts.push(Number.isInteger(raw) ? `${k}=${raw}i` : `${k}=${raw}`);
    } else {
      parts.push(`${k}=${escapeFieldString(String(raw))}`);
    }
  }
  return parts.join(",");
}

/** Build one Influx line-protocol line (no trailing newline). */
export function formatInfluxLine(point: InfluxPoint): string | undefined {
  const fields = formatFields(point.fields);
  if (!fields) return undefined;
  const ts = point.timestampNs ?? BigInt(Date.now()) * 1_000_000n;
  return `${escapeTagValue(point.measurement)}${formatTags(point.tags)} ${fields} ${ts}`;
}

export function formatInfluxLines(points: InfluxPoint[]): string {
  return points
    .map(formatInfluxLine)
    .filter((l): l is string => Boolean(l))
    .join("\n");
}

/** Ensure `precision=ns` is present (timestamps are nanoseconds). */
export function withInfluxPrecisionNs(url: string): string {
  const u = new URL(url);
  if (!u.searchParams.has("precision")) {
    u.searchParams.set("precision", "ns");
  }
  return u.toString();
}

function authHeaders(auth: InfluxWriteAuth | undefined): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
  };
  const token = auth?.token?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }
  const user = auth?.username?.trim();
  if (user) {
    const pass = auth?.password ?? "";
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  }
  return headers;
}

/**
 * Emit Influx LP points via HTTP POST (VictoriaMetrics /write, InfluxDB, …).
 * No-op (warn once per process) when url is empty.
 */
let warnedMissingUrl = false;

export async function emitInfluxWrite(
  url: string | undefined,
  points: InfluxPoint[],
  auth?: InfluxWriteAuth,
  opts?: { timeoutMs?: number },
): Promise<{ sent: number; skipped: boolean }> {
  if (!url?.trim()) {
    if (!warnedMissingUrl) {
      warnedMissingUrl = true;
      console.warn("INFLUX_WRITE_URL unset — skipping metric emit");
    }
    return { sent: 0, skipped: true };
  }
  const body = formatInfluxLines(points);
  if (!body) return { sent: 0, skipped: false };

  const target = withInfluxPrecisionNs(url.trim());
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: authHeaders(auth),
      body: `${body}\n`,
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `Influx write failed HTTP ${res.status}: ${text || res.statusText}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
  return { sent: points.length, skipped: false };
}
