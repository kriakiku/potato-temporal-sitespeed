function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value) return value;
  return fallback;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(
    `${name} must be a boolean (true/false), got: ${process.env[name]}`,
  );
}

export type WorkerEnv = {
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  potatoImage: string;
  potatoDataVolume: string;
  potatoApiToken?: string;
  potatoShapeExclude?: string;
  /**
   * Absolute path on the Podman/Docker engine host to a rules.expr file.
   * Bind-mounted to /data/rules.expr in every PotatoNetwork container.
   * Potato hot-reloads on mtime — edit the host file to swap policy without
   * restarting the worker (avoid atomic rename that replaces the inode).
   */
  potatoRulesExpr?: string;
  sitespeedImage: string;
  demoAuthIdentifier?: string;
  demoAuthPassword?: string;
  s3Endpoint?: string;
  s3Key?: string;
  s3Secret?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3ResultBaseUrl?: string;
  /**
   * Use path-style S3 URLs (endpoint/bucket/…) instead of virtual-hosted
   * (bucket.endpoint/…). Defaults to true when S3_ENDPOINT is set.
   */
  s3ForcePathStyle: boolean;
  /**
   * Run @sitespeed.io/plugin-lighthouse (plus1 image). Default false: empty
   * Lighthouse scores (common behind Potato MITM / SPAs) make the Graphite
   * plugin throw "No data to send" and fail the whole run.
   */
  sitespeedLighthouse: boolean;
  graphiteHost?: string;
  graphitePort: string;
  graphiteNamespaceBase: string;
  graphiteAuth?: string;
  /**
   * IPv4 (or resolvable name) of the engine host as seen from container
   * networks. Used when GRAPHITE_HOST / S3_ENDPOINT is loopback so sitespeed
   * inside potato netns can reach host services.
   */
  hostGateway?: string;
};

let cached: WorkerEnv | undefined;

export function getEnv(): WorkerEnv {
  if (cached) return cached;

  cached = {
    temporalAddress: optional("TEMPORAL_ADDRESS", "localhost:7233")!,
    temporalNamespace: optional("TEMPORAL_NAMESPACE", "default")!,
    temporalTaskQueue: optional("TEMPORAL_TASK_QUEUE", "sitespeed")!,
    potatoImage: optional(
      "POTATO_IMAGE",
      "ghcr.io/kriakiku/potato-network:latest",
    )!,
    potatoDataVolume: optional("POTATO_DATA_VOLUME", "potato-network-data")!,
    potatoApiToken: optional("POTATONETWORK_API_TOKEN"),
    potatoShapeExclude: optional("POTATONETWORK_SHAPE_EXCLUDE"),
    potatoRulesExpr: optional("POTATO_RULES_EXPR"),
    sitespeedImage: optional(
      "SITESPEED_IMAGE",
      "sitespeedio/sitespeed.io:40.0.0-plus1",
    )!,
    demoAuthIdentifier: optional("DEMO_AUTH_IDENTIFIER"),
    demoAuthPassword: optional("DEMO_AUTH_PASSWORD"),
    s3Endpoint: optional("S3_ENDPOINT"),
    s3Key: optional("S3_KEY"),
    s3Secret: optional("S3_SECRET"),
    s3Bucket: optional("S3_BUCKET"),
    s3Region: optional("S3_REGION"),
    s3ResultBaseUrl: optional("S3_RESULT_BASE_URL"),
    // Custom endpoints (MinIO, Ceph, …) usually need path-style addressing
    s3ForcePathStyle: optionalBool(
      "S3_FORCE_PATH_STYLE",
      Boolean(optional("S3_ENDPOINT")),
    ),
    sitespeedLighthouse: optionalBool("SITESPEED_LIGHTHOUSE", false),
    graphiteHost: optional("GRAPHITE_HOST"),
    graphitePort: optional("GRAPHITE_PORT", "2003")!,
    graphiteNamespaceBase: optional("GRAPHITE_NAMESPACE_BASE", "sitespeed")!,
    graphiteAuth: optional("GRAPHITE_AUTH"),
    hostGateway: optional("HOST_GATEWAY"),
  };

  return cached;
}

/** Throw if S3 export is partially configured. */
export function assertExportConfig(env: WorkerEnv): void {
  const s3Any = env.s3Key || env.s3Secret || env.s3Bucket;
  if (s3Any && !(env.s3Key && env.s3Secret && env.s3Bucket)) {
    throw new Error(
      "S3 export requires S3_KEY, S3_SECRET, and S3_BUCKET together",
    );
  }
}

export function requireForRefresh(_env: WorkerEnv): void {
  // Potato API token is optional (auth off when empty).
}

export { required, optional };
