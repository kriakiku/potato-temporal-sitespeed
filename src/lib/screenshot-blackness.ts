import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";

export type BlacknessResult = {
  path: string;
  width: number;
  height: number;
  blackRatio: number;
  blackPixels: number;
  totalPixels: number;
};

/** Recursively find PNG files under dir. */
export async function findPngFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await findPngFiles(full)));
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".png")) {
      out.push(full);
    }
  }
  return out;
}

/** Prefer real page screenshots over HTML report icons / layout-shift overlays. */
export async function findBestPageScreenshot(
  dir: string,
): Promise<string | undefined> {
  const files = await findPngFiles(dir);
  if (files.length === 0) return undefined;

  const score = (p: string) => {
    const n = p.replace(/\\/g, "/").toLowerCase();
    let s = 0;
    if (n.includes("/data/screenshots/")) s += 100;
    if (n.endsWith("/afterpagecompletecheck.png")) s += 50;
    if (n.endsWith("/largestcontentfulpaint.png")) s += 40;
    if (n.includes("/img/") || n.includes("/ico/")) s -= 100;
    if (n.includes("layoutshift")) s -= 10;
    return s;
  };

  const ranked = [...files].sort((a, b) => {
    const ds = score(b) - score(a);
    if (ds !== 0) return ds;
    return b.length - a.length;
  });
  return ranked[0];
}

/**
 * Fraction of pixels that are near-black (R,G,B all ≤ maxChannel).
 * Used to detect empty/black sitespeed screenshots.
 */
export function measurePngBlackness(
  pngBuffer: Buffer,
  maxChannel = 16,
): Omit<BlacknessResult, "path"> {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const totalPixels = width * height;
  let blackPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    // Ignore fully transparent pixels
    const a = data[i + 3]!;
    if (a < 8) continue;
    if (r <= maxChannel && g <= maxChannel && b <= maxChannel) {
      blackPixels++;
    }
  }
  const opaque = totalPixels; // count all pixels in ratio denominator for stable threshold
  return {
    width,
    height,
    blackPixels,
    totalPixels: opaque,
    blackRatio: opaque === 0 ? 1 : blackPixels / opaque,
  };
}

export async function analyzeScreenshotBlackness(
  pngPath: string,
  maxChannel = 16,
): Promise<BlacknessResult> {
  const buf = Buffer.from(await Bun.file(pngPath).arrayBuffer());
  const m = measurePngBlackness(buf, maxChannel);
  return { path: pngPath, ...m };
}
