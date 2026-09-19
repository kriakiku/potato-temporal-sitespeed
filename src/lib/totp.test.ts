import { describe, expect, test } from "bun:test";
import { decodeBase32, generateTotpCode } from "./totp";

describe("totp", () => {
  test("decodeBase32 ignores spaces and padding", () => {
    const a = decodeBase32("JBSWY3DPEHPK3PXP");
    const b = decodeBase32("jbswy 3dpeh pk3px p===");
    expect(a.equals(b)).toBe(true);
    expect(a.subarray(0, 6).toString("utf8")).toBe("Hello!");
  });

  // RFC 6238 Appendix B — secret ASCII "12345678901234567890" as base32,
  // 8-digit SHA1 at T=59 → 94287082.
  test("RFC 6238 SHA1 vector (8 digits)", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32("12345678901234567890")
    const code = generateTotpCode(secret, 59 * 1000, 30, 8);
    expect(code).toBe("94287082");
  });

  test("default 6-digit code length", () => {
    const code = generateTotpCode("JBSWY3DPEHPK3PXP", 1_700_000_000_000);
    expect(code).toMatch(/^\d{6}$/);
  });
});
