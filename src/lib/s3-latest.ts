import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { findLocalAsset } from "./sitespeed-json";

export type UploadLocalArtifactsInput = {
  resultRoot: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  forcePathStyle: boolean;
  /** Final prefix = artifact namespace (dotted). */
  latestPrefix: string;
  browser: string;
  connectivity: string;
};

export type UploadLocalArtifactsResult = {
  latestPrefix: string;
  uploaded: string[];
};

function createClient(input: UploadLocalArtifactsInput): S3Client {
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

function contentTypeFor(key: string): string | undefined {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".json")) return "application/json";
  return undefined;
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

/**
 * Upload local screenshot/video/html from a sitespeed result tree to
 * `{latestPrefix}/{browser}.{connectivity}.{ext}` (+ index.html).
 */
export async function uploadLocalSitespeedArtifacts(
  input: UploadLocalArtifactsInput,
): Promise<UploadLocalArtifactsResult> {
  const client = createClient(input);
  const bucket = input.bucket;
  const latestPrefix = input.latestPrefix.replace(/^\/+|\/+$/g, "");
  const browser = input.browser.replace(/[^a-zA-Z0-9_-]/g, "") || "chrome";
  const connectivity =
    input.connectivity.replace(/[^a-zA-Z0-9_-]/g, "") || "native";

  const uploads: Array<{ path: string; key: string }> = [];
  const png = await findLocalAsset(input.resultRoot, ".png");
  if (png) {
    uploads.push({
      path: png,
      key: `${latestPrefix}/${browser}.${connectivity}.png`,
    });
  }
  const mp4 = await findLocalAsset(input.resultRoot, ".mp4");
  if (mp4) {
    uploads.push({
      path: mp4,
      key: `${latestPrefix}/${browser}.${connectivity}.mp4`,
    });
  }
  const html = await findLocalAsset(input.resultRoot, ".html");
  if (html) {
    uploads.push({ path: html, key: `${latestPrefix}/index.html` });
  }

  if (uploads.length === 0) {
    throw new Error(
      `No screenshot/video/html found under ${input.resultRoot}`,
    );
  }

  const oldLatest = await listAllKeys(client, bucket, `${latestPrefix}/`);
  if (oldLatest.length) await deleteKeys(client, bucket, oldLatest);

  for (const { path, key } of uploads) {
    const body = createReadStream(path);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentTypeFor(key),
      }),
    );
  }

  return {
    latestPrefix,
    uploaded: uploads.map((u) => u.key),
  };
}
