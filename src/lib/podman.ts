/**
 * Thin helpers around dockerode. Auto-detects Engine API socket:
 * Podman first, then Docker.
 */
import { existsSync } from "node:fs";
import Dockerode from "dockerode";

export class PodmanError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PodmanError";
  }
}

export type PortBinding = {
  host: string;
  port: number;
};

export type RunContainerOptions = {
  name: string;
  image: string;
  cmd?: string[];
  /** Override image ENTRYPOINT (e.g. ["/bin/bash","-c"]). */
  entrypoint?: string[];
  env?: Record<string, string>;
  capAdd?: string[];
  /** e.g. ["vol:/data", "vol:/potato-data:ro"] */
  binds?: string[];
  /** e.g. "container:potato-xyz" */
  networkMode?: string;
  publish?: Array<{
    containerPort: number;
    hostIp?: string;
    hostPort?: string;
  }>;
  shmSizeBytes?: number;
};

function candidateSockets(): string[] {
  const uid =
    typeof process.getuid === "function" ? String(process.getuid()) : undefined;
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();

  return [
    "/run/podman/podman.sock",
    xdg ? `${xdg}/podman/podman.sock` : undefined,
    uid ? `/run/user/${uid}/podman/podman.sock` : undefined,
    "/var/run/docker.sock",
    "/run/docker.sock",
  ].filter((p): p is string => Boolean(p));
}

let client: Dockerode | undefined;
let resolvedSocket: string | undefined;

async function engine(): Promise<Dockerode> {
  if (client) return client;

  const candidates = candidateSockets();
  const present = candidates.filter((p) => existsSync(p));
  const errors: string[] = [];

  for (const path of present.length ? present : candidates) {
    try {
      const d = new Dockerode({ socketPath: path });
      await d.ping();
      client = d;
      resolvedSocket = path;
      return client;
    } catch (err) {
      errors.push(
        `${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new PodmanError(
    `No working Podman/Docker socket found. Tried: ${candidates.join(", ")}. ${errors.join("; ")}`,
  );
}

export function detectedSocketPath(): string | undefined {
  return resolvedSocket;
}

function isIPv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function splitImage(image: string): { repo: string; tag: string } {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return {
      repo: image.slice(0, lastColon),
      tag: image.slice(lastColon + 1) || "latest",
    };
  }
  return { repo: image, tag: "latest" };
}

async function pullImage(image: string): Promise<void> {
  const d = await engine();
  const { repo, tag } = splitImage(image);
  await new Promise<void>((resolve, reject) => {
    d.pull(
      `${repo}:${tag}`,
      (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }
        d.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) reject(err2);
          else resolve();
        });
      },
    );
  });
}

function toCreateOptions(
  opts: RunContainerOptions,
): Dockerode.ContainerCreateOptions {
  const exposed: Record<string, object> = {};
  const portBindings: Record<
    string,
    Array<{ HostIp?: string; HostPort: string }>
  > = {};

  for (const p of opts.publish ?? []) {
    const key = `${p.containerPort}/tcp`;
    exposed[key] = {};
    portBindings[key] = [
      {
        HostIp: p.hostIp ?? "127.0.0.1",
        HostPort: p.hostPort ?? "",
      },
    ];
  }

  return {
    name: opts.name,
    Image: opts.image,
    Cmd: opts.cmd,
    Entrypoint: opts.entrypoint,
    Env: opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : undefined,
    ExposedPorts: Object.keys(exposed).length ? exposed : undefined,
    HostConfig: {
      CapAdd: opts.capAdd,
      Binds: opts.binds,
      NetworkMode: opts.networkMode,
      PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
      ShmSize: opts.shmSizeBytes,
      AutoRemove: false,
    },
  };
}

export const podman = {
  /** Pull (or refresh) an image tag from the registry. */
  async pullImage(image: string): Promise<void> {
    try {
      await pullImage(image);
    } catch (err) {
      throw new PodmanError(`image pull failed: ${image}`, err);
    }
  },

  async ping(): Promise<void> {
    try {
      await (await engine()).ping();
    } catch (err) {
      throw new PodmanError("Container engine ping failed", err);
    }
  },

  /** Best-effort IPv4 gateway from the engine default/"podman" network. */
  async defaultNetworkGateway(): Promise<string | undefined> {
    try {
      const d = await engine();
      const networks = await d.listNetworks();
      const preferred = ["podman", "bridge"];
      const ordered = [
        ...networks.filter((n) => preferred.includes(n.Name)),
        ...networks.filter((n) => !preferred.includes(n.Name)),
      ];
      for (const n of ordered) {
        const info = await d.getNetwork(n.Id).inspect();
        const configs = info.IPAM?.Config ?? [];
        for (const c of configs) {
          const gw = (c as { Gateway?: string }).Gateway?.trim();
          if (gw && isIPv4(gw)) return gw;
        }
      }
    } catch {
      // ignore — caller falls back to HOST_GATEWAY / host.*.internal
    }
    return undefined;
  },

  async volumeExists(name: string): Promise<boolean> {
    try {
      await (await engine()).getVolume(name).inspect();
      return true;
    } catch {
      return false;
    }
  },

  async volumeCreate(name: string): Promise<void> {
    try {
      await (await engine()).createVolume({ Name: name });
    } catch (err: unknown) {
      const status =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode?: number }).statusCode
          : undefined;
      if (status === 409) return;
      throw new PodmanError(`volume create failed: ${name}`, err);
    }
  },

  async removeContainer(nameOrId: string, force = true): Promise<void> {
    try {
      await (await engine()).getContainer(nameOrId).remove({ force, v: true });
    } catch (err: unknown) {
      const status =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode?: number }).statusCode
          : undefined;
      if (status === 404) return;
      throw new PodmanError(`container rm failed: ${nameOrId}`, err);
    }
  },

  async stopContainer(nameOrId: string, timeoutSec = 10): Promise<void> {
    try {
      await (await engine()).getContainer(nameOrId).stop({ t: timeoutSec });
    } catch (err: unknown) {
      const status =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode?: number }).statusCode
          : undefined;
      if (status === 304 || status === 404) return;
      throw new PodmanError(`container stop failed: ${nameOrId}`, err);
    }
  },

  async inspectPort(
    nameOrId: string,
    containerPort: number,
  ): Promise<PortBinding | null> {
    try {
      const info = await (await engine()).getContainer(nameOrId).inspect();
      const bindings = info.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
      if (!bindings?.length) return null;
      const b = bindings[0];
      return {
        host: b.HostIp || "127.0.0.1",
        port: Number(b.HostPort),
      };
    } catch {
      return null;
    }
  },

  /** True when a container with this name exists and is running. */
  async isContainerRunning(nameOrId: string): Promise<boolean> {
    try {
      const info = await (await engine()).getContainer(nameOrId).inspect();
      return info.State?.Running === true;
    } catch {
      return false;
    }
  },

  /** Container names (no leading slash) that start with `prefix`. */
  async listContainerNamesByPrefix(prefix: string): Promise<string[]> {
    try {
      const list = await (await engine()).listContainers({ all: true });
      const out: string[] = [];
      for (const c of list) {
        for (const raw of c.Names ?? []) {
          const name = raw.replace(/^\//, "");
          if (name.startsWith(prefix)) out.push(name);
        }
      }
      return [...new Set(out)];
    } catch (err) {
      throw new PodmanError(
        `list containers by prefix failed: ${prefix}`,
        err,
      );
    }
  },

  /**
   * Reclaim disk: remove prefixed leftovers, then prune stopped containers,
   * unused networks, unused volumes (except `keepVolumes`), dangling images,
   * and build cache. Does **not** pull images.
   */
  async pruneStaleResources(opts: {
    containerNamePrefixes: string[];
    keepVolumes: string[];
    /** Called between slow steps so Temporal heartbeats stay alive. */
    onTick?: (step: string) => void;
  }): Promise<{
    removedContainers: string[];
    prunedContainers: unknown;
    prunedNetworks: unknown;
    removedVolumes: string[];
    prunedImages: unknown;
    prunedBuilder: unknown;
  }> {
    const d = await engine();
    const keep = new Set(opts.keepVolumes.filter(Boolean));
    const removedContainers: string[] = [];
    const tick = (step: string) => opts.onTick?.(step);

    for (const prefix of opts.containerNamePrefixes) {
      tick(`list-${prefix}`);
      const names = await this.listContainerNamesByPrefix(prefix);
      for (const name of names) {
        tick(`rm-${name}`);
        // Force-rm only — graceful stop can hang past activity heartbeats.
        await this.removeContainer(name, true).catch(() => undefined);
        removedContainers.push(name);
      }
    }

    let prunedContainers: unknown;
    let prunedNetworks: unknown;
    let prunedImages: unknown;
    let prunedBuilder: unknown;
    try {
      tick("prune-containers");
      prunedContainers = await d.pruneContainers({});
    } catch (err) {
      throw new PodmanError("prune containers failed", err);
    }
    try {
      tick("prune-networks");
      prunedNetworks = await d.pruneNetworks({});
    } catch (err) {
      throw new PodmanError("prune networks failed", err);
    }

    const removedVolumes: string[] = [];
    try {
      tick("list-volumes");
      const listed = await d.listVolumes();
      const volumes = (listed.Volumes ?? []) as Array<{ Name?: string }>;
      for (const v of volumes) {
        const name = v.Name?.trim();
        if (!name || keep.has(name)) continue;
        tick(`rm-volume-${name}`);
        try {
          await d.getVolume(name).remove({ force: true });
          removedVolumes.push(name);
        } catch {
          // in use or protected — skip
        }
      }
    } catch (err) {
      throw new PodmanError("list/remove volumes failed", err);
    }

    try {
      tick("prune-images");
      // Default dangling=true: only unused untagged layers (keep Potato/sitespeed tags).
      prunedImages = await d.pruneImages({});
    } catch (err) {
      throw new PodmanError("prune images failed", err);
    }
    try {
      tick("prune-builder");
      prunedBuilder = await d.pruneBuilder({});
    } catch {
      // Podman may not support build prune — non-fatal
      prunedBuilder = { skipped: true };
    }

    tick("prune-done");
    return {
      removedContainers,
      prunedContainers,
      prunedNetworks,
      removedVolumes,
      prunedImages,
      prunedBuilder,
    };
  },

  async runDetached(
    opts: RunContainerOptions & { /** Default true — remove existing name first. */ forceReplace?: boolean },
  ): Promise<{ id: string; name: string }> {
    if (opts.forceReplace !== false) {
      await this.removeContainer(opts.name, true);
    }
    await pullImage(opts.image);
    try {
      const d = await engine();
      const container = await d.createContainer(toCreateOptions(opts));
      await container.start();
      return { id: container.id, name: opts.name };
    } catch (err) {
      throw new PodmanError(`failed to run detached ${opts.name}`, err);
    }
  },

  async runToCompletion(
    opts: RunContainerOptions,
    onTick?: () => void,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (signal?.aborted) {
      throw new PodmanCancelledError(`cancelled before start: ${opts.name}`);
    }

    // Heartbeat from the start — image pull / create can exceed activity
    // heartbeatTimeout if we only tick after container.wait().
    const tick = setInterval(() => onTick?.(), 10_000);
    onTick?.();

    let container: Dockerode.Container | undefined;
    try {
      await this.removeContainer(opts.name, true);
      onTick?.();
      await pullImage(opts.image);
      onTick?.();

      try {
        const d = await engine();
        container = await d.createContainer(toCreateOptions(opts));
        await container.start();
      } catch (err) {
        throw new PodmanError(`failed to start ${opts.name}`, err);
      }

      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        if (!container) return;
        void this.stopContainer(container.id, 3).finally(() => {
          void this.removeContainer(container!.id, true);
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let exitCode = 1;
      try {
        if (signal?.aborted) {
          onAbort();
          throw new PodmanCancelledError(`cancelled: ${opts.name}`);
        }

        const result = await Promise.race([
          container.wait(),
          abortPromise(signal),
        ]);

        if (result === ABORTED || cancelled || signal?.aborted) {
          throw new PodmanCancelledError(`cancelled: ${opts.name}`);
        }

        exitCode =
          typeof result === "object" && result && "StatusCode" in result
            ? Number((result as { StatusCode: number }).StatusCode)
            : 1;
      } catch (err) {
        if (
          err instanceof PodmanCancelledError ||
          cancelled ||
          signal?.aborted
        ) {
          if (container) {
            await this.stopContainer(container.id, 3).catch(() => undefined);
            await this.removeContainer(container.id, true).catch(
              () => undefined,
            );
          }
          throw err instanceof PodmanCancelledError
            ? err
            : new PodmanCancelledError(`cancelled: ${opts.name}`);
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }

      let stdout = "";
      let stderr = "";
      try {
        const buf = (await container.logs({
          stdout: true,
          stderr: true,
          follow: false,
          timestamps: false,
        })) as Buffer;
        const demuxed = demuxDockerLogs(new Uint8Array(buf));
        stdout = demuxed.stdout;
        stderr = demuxed.stderr;
      } catch {
        // ignore log fetch errors
      }

      await this.removeContainer(container.id, true);
      return { exitCode, stdout, stderr };
    } finally {
      clearInterval(tick);
    }
  },
};

export class PodmanCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodmanCancelledError";
  }
}

const ABORTED = Symbol("aborted");

function abortPromise(signal?: AbortSignal): Promise<typeof ABORTED> {
  if (!signal) {
    return new Promise(() => {
      /* never resolves without a signal */
    });
  }
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

/** Docker log multiplex: [stream:u8][0,0,0][size:u32be][payload] */
function demuxDockerLogs(buf: Uint8Array): {
  stdout: string;
  stderr: string;
} {
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let i = 0;
  if (buf.length < 8) {
    return { stdout: decoder.decode(buf), stderr: "" };
  }
  while (i + 8 <= buf.length) {
    const stream = buf[i];
    const size =
      ((buf[i + 4] << 24) |
        (buf[i + 5] << 16) |
        (buf[i + 6] << 8) |
        buf[i + 7]) >>>
      0;
    i += 8;
    if (i + size > buf.length) break;
    const chunk = decoder.decode(buf.subarray(i, i + size));
    i += size;
    if (stream === 2) stderr += chunk;
    else stdout += chunk;
  }
  if (!stdout && !stderr && buf.length) {
    stdout = decoder.decode(buf);
  }
  return { stdout, stderr };
}
