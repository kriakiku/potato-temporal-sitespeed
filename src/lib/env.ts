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

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer >= 1, got: ${process.env[name]}`);
  }
  return n;
}

function optionalBoolFlag(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
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
  /**
   * Max concurrent activity executions on this worker process (default 1).
   */
  maxConcurrentActivities: number;
  /**
   * Force Temporal TLS on/off. Unset → on when certs/CA present, else plaintext.
   */
  temporalTls?: boolean;
  /** Client certificate PEM path (mTLS; requires temporalTlsKeyPath). */
  temporalTlsCertPath?: string;
  /** Client private key PEM path (mTLS; requires temporalTlsCertPath). */
  temporalTlsKeyPath?: string;
  /** Optional server root CA PEM path. */
  temporalTlsCaPath?: string;
  /** Optional TLS SNI / serverNameOverride. */
  temporalTlsServerName?: string;
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
  /** Base32 TOTP secret; when set, auth/token gets extra.code */
  demoAuthAuthenticator?: string;
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
   * Run @sitespeed.io/plugin-lighthouse (plus1 image). Default true.
   */
  sitespeedLighthouse: boolean;
  /**
   * Absolute path on the engine host for per-run sitespeed result trees.
   * Must be visible to the worker process (bind-mount the same path when the
   * worker runs in a container). Default: /tmp/potato-sitespeed-results
   */
  sitespeedResultsDir: string;
  /**
   * HTTP URL for Influx line protocol writes (VictoriaMetrics `/write`,
   * cluster `/insert/.../influx/write`, etc.). Unset → skip metric emit.
   */
  influxWriteUrl?: string;
  influxWriteUsername?: string;
  influxWritePassword?: string;
  /** Bearer token; preferred over Basic when set. */
  influxWriteToken?: string;
  /** HTTP timeout for Influx write (default 45000). */
  influxWriteTimeoutMs: number;
  /** First segment of artifact namespace / S3 prefix (was GRAPHITE_NAMESPACE_BASE). */
  artifactNamespaceBase: string;
  /**
   * Primary apex domain (e.g. example.com). When the workflow `tld` differs
   * (e.g. neo.com), keys get isMirror=true. Unset → always false.
   */
  baseTld?: string;
  /**
   * IPv4 (or resolvable name) of the engine host as seen from container
   * networks. Used when INFLUX_WRITE_URL / S3_ENDPOINT is loopback so services
   * inside potato netns (shape exclude) and worker can reach host listeners.
   */
  hostGateway?: string;
  /** Absolute path to potato config.json (`{ "autostart": [...] }`). */
  configPath: string;
  /** Absolute path to autostart round-robin state `{ nextIndex }`. */
  autostartStatePath: string;
  /** Temporal Schedule interval string for helper CLI (e.g. `5m`). */
  autostartScheduleInterval: string;
};

/** Strip scheme/trailing slash and lowercase for host comparison. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

let cached: WorkerEnv | undefined;

export function getEnv(): WorkerEnv {
  if (cached) return cached;

  const namespaceBase =
    optional("ARTIFACT_NAMESPACE_BASE") ??
    optional("GRAPHITE_NAMESPACE_BASE", "sitespeed")!;

  const resultsDir = optional(
    "SITESPEED_RESULTS_DIR",
    "/tmp/potato-sitespeed-results",
  )!;

  cached = {
    temporalAddress: optional("TEMPORAL_ADDRESS", "localhost:7233")!,
    temporalNamespace: optional("TEMPORAL_NAMESPACE", "default")!,
    temporalTaskQueue: optional("TEMPORAL_TASK_QUEUE", "sitespeed")!,
    maxConcurrentActivities: optionalInt("MAX_CONCURRENT_ACTIVITIES", 1),
    temporalTls: optionalBoolFlag("TEMPORAL_TLS"),
    temporalTlsCertPath: optional("TEMPORAL_TLS_CERT_PATH"),
    temporalTlsKeyPath: optional("TEMPORAL_TLS_KEY_PATH"),
    temporalTlsCaPath: optional("TEMPORAL_TLS_CA_PATH"),
    temporalTlsServerName: optional("TEMPORAL_TLS_SERVER_NAME"),
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
    demoAuthAuthenticator: optional("DEMO_AUTH_AUTHENTICATOR"),
    s3Endpoint: optional("S3_ENDPOINT"),
    s3Key: optional("S3_KEY"),
    s3Secret: optional("S3_SECRET"),
    s3Bucket: optional("S3_BUCKET"),
    s3Region: optional("S3_REGION"),
    s3ResultBaseUrl: optional("S3_RESULT_BASE_URL"),
    s3ForcePathStyle: optionalBool(
      "S3_FORCE_PATH_STYLE",
      Boolean(optional("S3_ENDPOINT")),
    ),
    sitespeedLighthouse: optionalBool("SITESPEED_LIGHTHOUSE", true),
    sitespeedResultsDir: resultsDir,
    influxWriteUrl: optional("INFLUX_WRITE_URL"),
    influxWriteUsername: optional("INFLUX_WRITE_USERNAME"),
    influxWritePassword: optional("INFLUX_WRITE_PASSWORD"),
    influxWriteToken: optional("INFLUX_WRITE_TOKEN"),
    influxWriteTimeoutMs: optionalInt("INFLUX_WRITE_TIMEOUT_MS", 45_000),
    artifactNamespaceBase: namespaceBase,
    baseTld: (() => {
      const raw = optional("BASE_TLD");
      return raw ? normalizeHost(raw) : undefined;
    })(),
    hostGateway: optional("HOST_GATEWAY"),
    configPath: optional(
      "CONFIG_PATH",
      `${resultsDir}/config.json`,
    )!,
    autostartStatePath: optional(
      "AUTOSTART_STATE_PATH",
      `${resultsDir}/autostart-state.json`,
    )!,
    autostartScheduleInterval: optional("AUTOSTART_SCHEDULE_INTERVAL", "5m")!,
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
  if (!env.sitespeedResultsDir.startsWith("/")) {
    throw new Error(
      `SITESPEED_RESULTS_DIR must be an absolute path on the engine host (got: ${env.sitespeedResultsDir})`,
    );
  }
  if (!env.configPath.startsWith("/")) {
    throw new Error(
      `CONFIG_PATH must be an absolute path (got: ${env.configPath})`,
    );
  }
  if (!env.autostartStatePath.startsWith("/")) {
    throw new Error(
      `AUTOSTART_STATE_PATH must be an absolute path (got: ${env.autostartStatePath})`,
    );
  }
}

export function requireForRefresh(_env: WorkerEnv): void {
  // Potato API token is optional (auth off when empty).
}

export { required, optional };
