/**
 * Podman/Docker Engine API client over a Unix socket (no podman CLI).
 * Bun fetch supports `unix:`; default socket is /run/podman/podman.sock.
 */

export class PodmanError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
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
  /** Publish containerPort; empty hostPort → random */
  publish?: Array<{
    containerPort: number;
    hostIp?: string;
    hostPort?: string;
  }>;
  shmSizeBytes?: number;
  /** Remove container when it exits (Docker AutoRemove) */
  autoRemove?: boolean;
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

async function api(path: string, init?: RequestInit): Promise<Response> {
  const unix = socketPath();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  return fetch(`http://localhost/v1.41${path}`, {
    ...init,
    headers,
    // Bun: dial Podman/Docker Engine API over a Unix socket
    unix,
  } as RequestInit & { unix: string });
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { message?: string };
      return j.message || text;
    } catch {
      return text;
    }
  } catch {
    return res.statusText;
  }
}

function splitImage(image: string): { name: string; tag: string } {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return {
      name: image.slice(0, lastColon),
      tag: image.slice(lastColon + 1) || "latest",
    };
  }
  return { name: image, tag: "latest" };
}

export const podman = {
  socketPath,

  async ping(): Promise<void> {
    const res = await api("/_ping");
    if (!res.ok) {
      throw new PodmanError(
        `Podman socket ping failed: ${await readError(res)}`,
        res.status,
      );
    }
  },

  async volumeExists(name: string): Promise<boolean> {
    const res = await api(`/volumes/${encodeURIComponent(name)}`);
    return res.ok;
  },

  async volumeCreate(name: string): Promise<void> {
    const res = await api("/volumes/create", {
      method: "POST",
      body: JSON.stringify({ Name: name }),
    });
    if (!res.ok && res.status !== 409) {
      throw new PodmanError(
        `volume create failed: ${await readError(res)}`,
        res.status,
      );
    }
  },

  async ensureImage(image: string): Promise<void> {
    const { name, tag } = splitImage(image);
    const qs = new URLSearchParams({ fromImage: name, tag });
    const res = await api(`/images/create?${qs}`, { method: "POST" });
    // Pull streams JSON progress lines; drain body
    const text = await res.text();
    if (!res.ok) {
      throw new PodmanError(`image pull failed: ${text}`, res.status, text);
    }
  },

  async removeContainer(nameOrId: string, force = true): Promise<void> {
    const qs = force ? "?force=true&v=true" : "";
    const res = await api(
      `/containers/${encodeURIComponent(nameOrId)}${qs}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) {
      throw new PodmanError(
        `container rm failed: ${await readError(res)}`,
        res.status,
      );
    }
  },

  async stopContainer(nameOrId: string, timeoutSec = 10): Promise<void> {
    const res = await api(
      `/containers/${encodeURIComponent(nameOrId)}/stop?t=${timeoutSec}`,
      { method: "POST" },
    );
    if (!res.ok && res.status !== 304 && res.status !== 404) {
      throw new PodmanError(
        `container stop failed: ${await readError(res)}`,
        res.status,
      );
    }
  },

  async createContainer(opts: RunContainerOptions): Promise<string> {
    await this.ensureImage(opts.image);

    const exposed: Record<string, Record<string, never>> = {};
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

    const body = {
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
        PortBindings: Object.keys(portBindings).length
          ? portBindings
          : undefined,
        ShmSize: opts.shmSizeBytes,
        AutoRemove: opts.autoRemove ?? false,
      },
    };

    const res = await api(
      `/containers/create?name=${encodeURIComponent(opts.name)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!res.ok) {
      throw new PodmanError(
        `container create failed: ${await readError(res)}`,
        res.status,
      );
    }
    const json = (await res.json()) as { Id: string };
    return json.Id;
  },

  async startContainer(id: string): Promise<void> {
    const res = await api(`/containers/${encodeURIComponent(id)}/start`, {
      method: "POST",
    });
    if (!res.ok && res.status !== 304) {
      throw new PodmanError(
        `container start failed: ${await readError(res)}`,
        res.status,
      );
    }
  },

  async inspectPort(
    nameOrId: string,
    containerPort: number,
  ): Promise<PortBinding | null> {
    const res = await api(`/containers/${encodeURIComponent(nameOrId)}/json`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      NetworkSettings?: {
        Ports?: Record<
          string,
          Array<{ HostIp: string; HostPort: string }> | null
        >;
      };
    };
    const bindings = json.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
    if (!bindings?.length) return null;
    const b = bindings[0];
    return { host: b.HostIp || "127.0.0.1", port: Number(b.HostPort) };
  },

  async wait(nameOrId: string): Promise<number> {
    const res = await api(
      `/containers/${encodeURIComponent(nameOrId)}/wait`,
      { method: "POST" },
    );
    if (!res.ok) {
      throw new PodmanError(
        `container wait failed: ${await readError(res)}`,
        res.status,
      );
    }
    const json = (await res.json()) as { StatusCode: number };
    return json.StatusCode;
  },

  async logs(nameOrId: string): Promise<{ stdout: string; stderr: string }> {
    const res = await api(
      `/containers/${encodeURIComponent(nameOrId)}/logs?stdout=1&stderr=1&timestamps=0`,
    );
    if (!res.ok) {
      throw new PodmanError(
        `container logs failed: ${await readError(res)}`,
        res.status,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return demuxDockerLogs(buf);
  },

  /** Create + start a detached container; returns name (stable) and id. */
  async runDetached(
    opts: RunContainerOptions,
  ): Promise<{ id: string; name: string }> {
    await this.removeContainer(opts.name, true);
    const id = await this.createContainer({ ...opts, autoRemove: false });
    await this.startContainer(id);
    return { id, name: opts.name };
  },

  /**
   * Run to completion, heartbeating while waiting.
   * Collects logs after exit, then removes the container.
   */
  async runToCompletion(
    opts: RunContainerOptions,
    onTick?: () => void,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.removeContainer(opts.name, true);
    const id = await this.createContainer({ ...opts, autoRemove: false });
    await this.startContainer(id);

    const tick = setInterval(() => onTick?.(), 10_000);
    let exitCode: number;
    try {
      exitCode = await this.wait(id);
    } finally {
      clearInterval(tick);
    }

    let stdout = "";
    let stderr = "";
    try {
      const logs = await this.logs(id);
      stdout = logs.stdout;
      stderr = logs.stderr;
    } catch {
      // container may already be gone
    }

    await this.removeContainer(id, true);
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
  // If no headers (TTY), treat all as stdout
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
  // Fallback: undecodable multiplex → raw text
  if (!stdout && !stderr && buf.length) {
    stdout = decoder.decode(buf);
  }
  return { stdout, stderr };
}
