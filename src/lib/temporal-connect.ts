import { readFile } from "node:fs/promises";
import type { TLSConfig } from "@temporalio/common/lib/internal-non-workflow";
import type { WorkerEnv } from "./env";

export type TemporalTlsMaterials = {
  cert?: Uint8Array;
  key?: Uint8Array;
  ca?: Uint8Array;
};

export type TemporalConnectionOptions = {
  address: string;
  tls?: TLSConfig | true;
};

/** TLS summary for boot logs (no key material). */
export function temporalTlsLogFlags(env: WorkerEnv): {
  temporalTls: boolean;
  temporalTlsClientCert: boolean;
  temporalTlsCa: boolean;
} {
  const hasPair = Boolean(env.temporalTlsCertPath && env.temporalTlsKeyPath);
  const hasCa = Boolean(env.temporalTlsCaPath);
  const temporalTls =
    env.temporalTls === true ||
    (env.temporalTls !== false && (hasPair || hasCa));
  return {
    temporalTls,
    temporalTlsClientCert: hasPair,
    temporalTlsCa: hasCa,
  };
}

/**
 * Build SDK `tls` option from env + optional preloaded PEM bytes.
 * Returns `undefined` for plaintext, `true` for TLS without custom materials,
 * or a `TLSConfig` object for mTLS / custom CA / SNI.
 */
export function buildTemporalTlsConfig(
  env: Pick<
    WorkerEnv,
    | "temporalTls"
    | "temporalTlsCertPath"
    | "temporalTlsKeyPath"
    | "temporalTlsCaPath"
    | "temporalTlsServerName"
  >,
  materials: TemporalTlsMaterials = {},
): TLSConfig | true | undefined {
  const certPath = env.temporalTlsCertPath?.trim();
  const keyPath = env.temporalTlsKeyPath?.trim();
  const caPath = env.temporalTlsCaPath?.trim();

  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    throw new Error(
      "TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH must be set together",
    );
  }

  const hasClientPair = Boolean(certPath && keyPath);
  const hasCa = Boolean(caPath);
  const hasServerName = Boolean(env.temporalTlsServerName?.trim());
  const hasMaterials = hasClientPair || hasCa || hasServerName;

  if (env.temporalTls === false && (hasClientPair || hasCa)) {
    throw new Error(
      "TEMPORAL_TLS=false conflicts with TEMPORAL_TLS_CERT_PATH / KEY / CA",
    );
  }

  const tlsEnabled =
    env.temporalTls === true || (env.temporalTls !== false && hasMaterials);

  if (!tlsEnabled) return undefined;

  if (!hasMaterials) return true;

  const tls: TLSConfig = {};

  if (hasClientPair) {
    if (!materials.cert || !materials.key) {
      throw new Error(
        "mTLS requires client certificate and key materials to be loaded",
      );
    }
    tls.clientCertPair = { crt: materials.cert, key: materials.key };
  }
  if (hasCa) {
    if (!materials.ca) {
      throw new Error("TEMPORAL_TLS_CA_PATH set but CA material was not loaded");
    }
    tls.serverRootCACertificate = materials.ca;
  }
  if (hasServerName) {
    tls.serverNameOverride = env.temporalTlsServerName!.trim();
  }

  return tls;
}

async function loadPem(path: string): Promise<Uint8Array> {
  const buf = await readFile(path);
  return new Uint8Array(buf);
}

/** Load PEM files referenced by env (if any). */
export async function loadTemporalTlsMaterials(
  env: Pick<
    WorkerEnv,
    "temporalTlsCertPath" | "temporalTlsKeyPath" | "temporalTlsCaPath"
  >,
): Promise<TemporalTlsMaterials> {
  const out: TemporalTlsMaterials = {};
  if (env.temporalTlsCertPath) {
    out.cert = await loadPem(env.temporalTlsCertPath);
  }
  if (env.temporalTlsKeyPath) {
    out.key = await loadPem(env.temporalTlsKeyPath);
  }
  if (env.temporalTlsCaPath) {
    out.ca = await loadPem(env.temporalTlsCaPath);
  }
  return out;
}

/** Options for NativeConnection.connect / Connection.connect. */
export async function temporalConnectionOptions(
  env: WorkerEnv,
): Promise<TemporalConnectionOptions> {
  const materials = await loadTemporalTlsMaterials(env);
  const tls = buildTemporalTlsConfig(env, materials);
  const opts: TemporalConnectionOptions = { address: env.temporalAddress };
  if (tls !== undefined) opts.tls = tls;
  return opts;
}
