import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode a base32 secret (Authenticator / Google Authenticator style). Ignores spaces and padding. */
export function decodeBase32(secret: string): Buffer {
  const cleaned = secret.replace(/[\s=]+/g, "").toUpperCase();
  if (!cleaned) {
    throw new Error("authenticator secret is empty");
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error(`invalid base32 character in authenticator secret: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * RFC 6238 TOTP (SHA-1, 30s step, 6 digits) — same defaults as typical
 * Authenticator apps.
 */
export function generateTotpCode(
  secret: string,
  nowMs: number = Date.now(),
  stepSec = 30,
  digits = 6,
): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(nowMs / 1000 / stepSec);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, "0");
}
