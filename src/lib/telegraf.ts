import { createSocket } from "node:dgram";
import { connect as netConnect } from "node:net";

export type TelegrafTags = Record<string, string | boolean | number | undefined>;
export type TelegrafFields = Record<string, number | string | boolean | undefined | null>;

export type TelegrafPoint = {
  measurement: string;
  tags?: TelegrafTags;
  fields: TelegrafFields;
  /** Unix nanoseconds; default now */
  timestampNs?: bigint;
};

function escapeTagValue(v: string): string {
  return v.replace(/[,\s=]/g, (c) => `\\${c}`);
}

function escapeFieldString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatTags(tags: TelegrafTags | undefined): string {
  if (!tags) return "";
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(tags)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const v = typeof raw === "boolean" || typeof raw === "number" ? String(raw) : raw;
    parts.push(`${escapeTagValue(k)}=${escapeTagValue(v)}`);
  }
  return parts.length ? `,${parts.join(",")}` : "";
}

function formatFields(fields: TelegrafFields): string {
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
export function formatInfluxLine(point: TelegrafPoint): string | undefined {
  const fields = formatFields(point.fields);
  if (!fields) return undefined;
  const ts = point.timestampNs ?? BigInt(Date.now()) * 1_000_000n;
  return `${escapeTagValue(point.measurement)}${formatTags(point.tags)} ${fields} ${ts}`;
}

export function formatInfluxLines(points: TelegrafPoint[]): string {
  return points
    .map(formatInfluxLine)
    .filter((l): l is string => Boolean(l))
    .join("\n");
}

export type ParsedTelegrafAddr = {
  protocol: "udp" | "tcp";
  host: string;
  port: number;
};

/** Parse `udp://host:8094`, `tcp://host:8094`, or `host:8094` (UDP default). */
export function parseTelegrafAddr(addr: string): ParsedTelegrafAddr {
  const raw = addr.trim();
  let protocol: "udp" | "tcp" = "udp";
  let rest = raw;
  const m = /^(udp|tcp):\/\//i.exec(raw);
  if (m) {
    protocol = m[1]!.toLowerCase() as "udp" | "tcp";
    rest = raw.slice(m[0].length);
  }
  const hostPort = rest.replace(/^\[|\]$/g, "");
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon <= 0) {
    throw new Error(`TELEGRAF_ADDR must be host:port (got: ${addr})`);
  }
  const host = hostPort.slice(0, lastColon).replace(/^\[|\]$/g, "");
  const port = Number(hostPort.slice(lastColon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TELEGRAF_ADDR invalid host/port: ${addr}`);
  }
  return { protocol, host, port };
}

async function sendUdp(host: string, port: number, payload: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.send(payload, port, host, (err) => {
      sock.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

async function sendTcp(host: string, port: number, payload: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = netConnect({ host, port }, () => {
      sock.end(payload, () => resolve());
    });
    sock.on("error", reject);
  });
}

/**
 * Emit Influx LP points to Telegraf socket_listener.
 * No-op (warn once per process) when addr is empty.
 */
let warnedMissingAddr = false;

export async function emitTelegraf(
  addr: string | undefined,
  points: TelegrafPoint[],
): Promise<{ sent: number; skipped: boolean }> {
  if (!addr?.trim()) {
    if (!warnedMissingAddr) {
      warnedMissingAddr = true;
      console.warn("TELEGRAF_ADDR unset — skipping metric emit");
    }
    return { sent: 0, skipped: true };
  }
  const body = formatInfluxLines(points);
  if (!body) return { sent: 0, skipped: false };

  const { protocol, host, port } = parseTelegrafAddr(addr);
  const payload = Buffer.from(`${body}\n`, "utf8");
  if (protocol === "tcp") {
    await sendTcp(host, port, payload);
  } else {
    await sendUdp(host, port, payload);
  }
  return { sent: points.length, skipped: false };
}
