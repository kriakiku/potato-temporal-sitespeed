import { describe, expect, test } from "bun:test";
import {
  buildTemporalTlsConfig,
  temporalTlsLogFlags,
} from "./temporal-connect";

const enc = new TextEncoder();

describe("buildTemporalTlsConfig", () => {
  test("no tls env → undefined (plaintext)", () => {
    expect(buildTemporalTlsConfig({})).toBeUndefined();
  });

  test("TEMPORAL_TLS=true alone → true", () => {
    expect(buildTemporalTlsConfig({ temporalTls: true })).toBe(true);
  });

  test("TEMPORAL_TLS=false → undefined", () => {
    expect(buildTemporalTlsConfig({ temporalTls: false })).toBeUndefined();
  });

  test("cert without key throws", () => {
    expect(() =>
      buildTemporalTlsConfig({ temporalTlsCertPath: "/c.pem" }),
    ).toThrow(/together/);
  });

  test("TEMPORAL_TLS=false with certs throws", () => {
    expect(() =>
      buildTemporalTlsConfig({
        temporalTls: false,
        temporalTlsCertPath: "/c.pem",
        temporalTlsKeyPath: "/k.pem",
      }),
    ).toThrow(/conflicts/);
  });

  test("cert+key with materials → clientCertPair", () => {
    const cert = enc.encode("CERT");
    const key = enc.encode("KEY");
    const tls = buildTemporalTlsConfig(
      {
        temporalTlsCertPath: "/c.pem",
        temporalTlsKeyPath: "/k.pem",
      },
      { cert, key },
    );
    expect(tls).toEqual({
      clientCertPair: { crt: cert, key },
    });
  });

  test("cert+key+ca+serverName", () => {
    const cert = enc.encode("CERT");
    const key = enc.encode("KEY");
    const ca = enc.encode("CA");
    const tls = buildTemporalTlsConfig(
      {
        temporalTls: true,
        temporalTlsCertPath: "/c.pem",
        temporalTlsKeyPath: "/k.pem",
        temporalTlsCaPath: "/ca.pem",
        temporalTlsServerName: "temporal.internal",
      },
      { cert, key, ca },
    );
    expect(tls).toEqual({
      clientCertPair: { crt: cert, key },
      serverRootCACertificate: ca,
      serverNameOverride: "temporal.internal",
    });
  });

  test("paths without loaded materials throws", () => {
    expect(() =>
      buildTemporalTlsConfig({
        temporalTlsCertPath: "/c.pem",
        temporalTlsKeyPath: "/k.pem",
      }),
    ).toThrow(/materials/);
  });
});

describe("temporalTlsLogFlags", () => {
  test("reflects enabled tls and client cert presence", () => {
    expect(
      temporalTlsLogFlags({
        temporalAddress: "x:7233",
        temporalNamespace: "default",
        temporalTaskQueue: "sitespeed",
        maxConcurrentActivities: 1,
        potatoImage: "p",
        potatoDataVolume: "v",
        sitespeedImage: "s",
        sitespeedLighthouse: true,
        sitespeedResultsDir: "/tmp",
        configPath: "/tmp/config.json",
        autostartStatePath: "/tmp/autostart-state.json",
        autostartScheduleInterval: "5m",
        influxWriteTimeoutMs: 45_000,
        s3ForcePathStyle: false,
        artifactNamespaceBase: "sitespeed",
        temporalTls: true,
        temporalTlsCertPath: "/c.pem",
        temporalTlsKeyPath: "/k.pem",
      }),
    ).toEqual({
      temporalTls: true,
      temporalTlsClientCert: true,
      temporalTlsCa: false,
    });
  });
});
