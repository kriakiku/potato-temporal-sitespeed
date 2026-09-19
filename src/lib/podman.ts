/**
 * Thin helpers around dockerode talking to Podman's Docker-compatible
 * Engine API on a Unix socket (no custom HTTP client).
 */
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

function socketPath(): string {
  const raw =
    process.env.PODMAN_SOCKET?.trim() ||
    process.env.CONTAINER_HOST?.trim() ||
    process.env.DOCKER_HOST?.trim() ||
    "unix:///run/podman/podman.sock";

  if (raw.startsWith("unix://")) return raw.slice("unix://".length);
  if (raw.startsWith("/")) return raw;
  throw new Error(
    `Unsupported container socket "${raw}" — expected unix:///path/to.sock`,
  );
}

let client: Dockerode | undefined;

function docker(): Dockerode {
  if (!client) {
    client = new Dockerode({ socketPath: socketPath() });
  }
  return client;
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
  const { repo, tag } = splitImage(image);
  await new Promise<void>((resolve, reject) => {
    docker().pull(`${repo}:${tag}`, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }
      docker().modem.followProgress(stream, (err2: Error | null) => {
        if (err2) reject(err2);
        else resolve();
      });
    });
  });
}

function toCreateOptions(opts: RunContainerOptions): Dockerode.ContainerCreateOptions {
  const exposed: Record<string, object> = {};
  const portBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> =
    {};

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
  socketPath,

  async ping(): Promise<void> {
    try {
      await docker().ping();
    } catch (err) {
      throw new PodmanError("Podman socket ping failed", err);
    }
  },

  async volumeExists(name: string): Promise<boolean> {
    try {
      await docker().getVolume(name).inspect();
      return true;
    } catch {
      return false;
    }
  },

  async volumeCreate(name: string): Promise<void> {
    try {
      await docker().createVolume({ Name: name });
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
      await docker().getContainer(nameOrId).remove({ force, v: true });
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
      await docker().getContainer(nameOrId).stop({ t: timeoutSec });
    } catch (err: unknown) {
      const status =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode?: number }).statusCode
          : undefined;
      // 304 = already stopped, 404 = gone
      if (status === 304 || status === 404) return;
      throw new PodmanError(`container stop failed: ${nameOrId}`, err);
    }
  },

  async inspectPort(
    nameOrId: string,
    containerPort: number,
  ): Promise<PortBinding | null> {
    try {
      const info = await docker().getContainer(nameOrId).inspect();
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

  async runDetached(
    opts: RunContainerOptions,
  ): Promise<{ id: string; name: string }> {
    await this.removeContainer(opts.name, true);
    await pullImage(opts.image);
    try {
      const container = await docker().createContainer(toCreateOptions(opts));
      await container.start();
      return { id: container.id, name: opts.name };
    } catch (err) {
      throw new PodmanError(`failed to run detached ${opts.name}`, err);
    }
  },

  async runToCompletion(
    opts: RunContainerOptions,
    onTick?: () => void,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.removeContainer(opts.name, true);
    await pullImage(opts.image);

    let container: Dockerode.Container;
    try {
      container = await docker().createContainer(toCreateOptions(opts));
      await container.start();
    } catch (err) {
      throw new PodmanError(`failed to start ${opts.name}`, err);
    }

    const tick = setInterval(() => onTick?.(), 10_000);
    let exitCode = 1;
    try {
      const result = await container.wait();
      exitCode =
        typeof result === "object" && result && "StatusCode" in result
          ? Number((result as { StatusCode: number }).StatusCode)
          : 1;
    } finally {
      clearInterval(tick);
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
  },
};

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
