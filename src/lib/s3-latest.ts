import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

const TIMESTAMP_DIR = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

export type PromoteS3LatestInput = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  forcePathStyle: boolean;
  /** Staging prefix sitespeed uploaded to (dashed slug). */
  uploadSlug: string;
  /** Final latest prefix = Graphite namespace (dotted). */
  latestPrefix: string;
  browser: string;
  connectivity: string;
};

export type PromoteS3LatestResult = {
  latestPrefix: string;
  runPrefix: string;
  copied: string[];
};

function createClient(input: PromoteS3LatestInput): S3Client {
  const config: S3ClientConfig = {
    region: input.region || "us-east-1",
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
  };
  if (input.endpoint) {
    config.endpoint = input.endpoint;
    config.forcePathStyle = input.forcePathStyle;
  } else if (input.forcePathStyle) {
    config.forcePathStyle = true;
  }
  return new S3Client(config);
}

async function listAllKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of out.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteKeys(
  client: S3Client,
  bucket: string,
  keys: string[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (chunk.length === 0) continue;
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
  }
}

function pickNewestTimestamp(keys: string[], slug: string): string | undefined {
  const prefix = slug.endsWith("/") ? slug : `${slug}/`;
  const stamps = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const seg = rest.split("/")[0];
    if (seg && TIMESTAMP_DIR.test(seg)) stamps.add(seg);
  }
  if (stamps.size === 0) return undefined;
  return [...stamps].sort().at(-1);
}

function contentTypeFor(key: string): string | undefined {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".webp")) return "image/webp";
  return undefined;
}

function pickAsset(
  keys: string[],
  ext: string,
  browser: string,
  connectivity: string,
): string | undefined {
  const lowerExt = ext.toLowerCase();
  const candidates = keys.filter((k) => k.toLowerCase().endsWith(lowerExt));
  if (candidates.length === 0) return undefined;

  const needle = `.${browser}.${connectivity}${lowerExt}`.toLowerCase();
  const preferred = candidates.filter((k) => k.toLowerCase().includes(needle));
  const pool = preferred.length ? preferred : candidates;

  // Prefer pages/ screenshots & videos over misc tiny assets
  const ranked = [...pool].sort((a, b) => {
    const score = (k: string) => {
      let s = 0;
      if (k.includes("/pages/")) s += 3;
      if (k.includes("/data/screenshots/") || k.includes("/data/video/")) s += 2;
      if (k.includes("#") || k.includes("%23")) s -= 1;
      return s;
    };
    return score(b) - score(a) || b.length - a.length;
  });
  return ranked[0];
}

function pickIndexHtml(keys: string[]): string | undefined {
  const pages = keys.filter(
    (k) => k.includes("/pages/") && k.endsWith("/index.html"),
  );
  if (pages.length) {
    return [...pages].sort((a, b) => a.length - b.length)[0];
  }
  return keys.find((k) => k.endsWith("/index.html"));
}

/**
 * After sitespeed uploads `{slug}/{timestamp}/…` (often with `#hash` in names),
 * copy clean latest assets to `{latestPrefix}/` and delete the timestamp folder.
 */
export async function promoteSitespeedLatestToNamespace(
  input: PromoteS3LatestInput,
): Promise<PromoteS3LatestResult> {
  const client = createClient(input);
  const bucket = input.bucket;
  const slug = input.uploadSlug.replace(/^\/+|\/+$/g, "");
  const latestPrefix = input.latestPrefix.replace(/^\/+|\/+$/g, "");

  const stagingKeys = await listAllKeys(client, bucket, `${slug}/`);
  const timestamp = pickNewestTimestamp(stagingKeys, slug);
  if (!timestamp) {
    throw new Error(
      `No sitespeed timestamp folder under s3://${bucket}/${slug}/`,
    );
  }

  const runPrefix = `${slug}/${timestamp}`;
  const runKeys = stagingKeys.filter(
    (k) => k === runPrefix || k.startsWith(`${runPrefix}/`),
  );

  const browser = input.browser.replace(/[^a-zA-Z0-9_-]/g, "") || "chrome";
  const connectivity =
    input.connectivity.replace(/[^a-zA-Z0-9_-]/g, "") || "native";

  const copies: Array<{ from: string; to: string }> = [];
  const png = pickAsset(runKeys, ".png", browser, connectivity);
  if (png) copies.push({ from: png, to: `${latestPrefix}/${browser}.${connectivity}.png` });
  const mp4 = pickAsset(runKeys, ".mp4", browser, connectivity);
  if (mp4) copies.push({ from: mp4, to: `${latestPrefix}/${browser}.${connectivity}.mp4` });
  const html = pickIndexHtml(runKeys);
  if (html) copies.push({ from: html, to: `${latestPrefix}/index.html` });

  if (copies.length === 0) {
    throw new Error(
      `No screenshot/video/html found under s3://${bucket}/${runPrefix}/`,
    );
  }

  // Replace previous latest for this dimension set
  const oldLatest = await listAllKeys(client, bucket, `${latestPrefix}/`);
  if (oldLatest.length) await deleteKeys(client, bucket, oldLatest);

  for (const { from, to } of copies) {
    const contentType = contentTypeFor(to);
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
        Key: to,
        ContentType: contentType,
        MetadataDirective: contentType ? "REPLACE" : "COPY",
      }),
    );
  }

  await deleteKeys(client, bucket, runKeys);

  return {
    latestPrefix,
    runPrefix,
    copied: copies.map((c) => c.to),
  };
}
