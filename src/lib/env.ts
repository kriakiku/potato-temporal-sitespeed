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

export type WorkerEnv = {
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  potatoImage: string;
  potatoDataVolume: string;
  potatoApiToken?: string;
  potatoShapeExclude?: string;
  sitespeedImage: string;
  demoAuthIdentifier?: string;
  demoAuthPassword?: string;
  podmanSocket: string;
  s3Endpoint?: string;
  s3Key?: string;
  s3Secret?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3ResultBaseUrl?: string;
  graphiteHost?: string;
  graphitePort: string;
  graphiteNamespaceBase: string;
  graphiteAuth?: string;
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
    sitespeedImage: optional(
      "SITESPEED_IMAGE",
      "sitespeedio/sitespeed.io:38.0.0",
    )!,
    demoAuthIdentifier: optional("DEMO_AUTH_IDENTIFIER"),
    demoAuthPassword: optional("DEMO_AUTH_PASSWORD"),
    podmanSocket: optional(
      "PODMAN_SOCKET",
      optional("CONTAINER_HOST", "unix:///run/podman/podman.sock")!,
    )!,
    s3Endpoint: optional("S3_ENDPOINT"),
    s3Key: optional("S3_KEY"),
    s3Secret: optional("S3_SECRET"),
    s3Bucket: optional("S3_BUCKET"),
    s3Region: optional("S3_REGION"),
    s3ResultBaseUrl: optional("S3_RESULT_BASE_URL"),
    graphiteHost: optional("GRAPHITE_HOST"),
    graphitePort: optional("GRAPHITE_PORT", "2003")!,
    graphiteNamespaceBase: optional("GRAPHITE_NAMESPACE_BASE", "sitespeed")!,
    graphiteAuth: optional("GRAPHITE_AUTH"),
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
