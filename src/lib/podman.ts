export type PodmanResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export class PodmanError extends Error {
  constructor(
    message: string,
    readonly result: PodmanResult,
  ) {
    super(message);
    this.name = "PodmanError";
  }
}

async function run(
  args: string[],
  opts?: { allowFailure?: boolean },
): Promise<PodmanResult> {
  const proc = Bun.spawn(["podman", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const result: PodmanResult = {
    code: code ?? 1,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };

  if (result.code !== 0 && !opts?.allowFailure) {
    throw new PodmanError(
      `podman ${args[0]} failed (${result.code}): ${result.stderr || result.stdout}`,
      result,
    );
  }

  return result;
}

export const podman = {
  run,
  async version(): Promise<string> {
    const r = await run(["--version"]);
    return r.stdout;
  },
  async volumeExists(name: string): Promise<boolean> {
    const r = await run(["volume", "exists", name], { allowFailure: true });
    return r.code === 0;
  },
  async volumeCreate(name: string): Promise<void> {
    await run(["volume", "create", name]);
  },
  async inspectPort(
    container: string,
    containerPort: number,
  ): Promise<{ host: string; port: number } | null> {
    const r = await run(["port", container, String(containerPort)], {
      allowFailure: true,
    });
    if (r.code !== 0 || !r.stdout) return null;
    // e.g. "127.0.0.1:45678" or "0.0.0.0:45678"
    const line = r.stdout.split("\n")[0]?.trim();
    if (!line) return null;
    const match = line.match(/([\d.]+):(\d+)$/);
    if (!match) return null;
    return { host: match[1], port: Number(match[2]) };
  },
  async rm(container: string, force = true): Promise<void> {
    const args = ["rm"];
    if (force) args.push("-f");
    args.push(container);
    await run(args, { allowFailure: true });
  },
  async stop(container: string): Promise<void> {
    await run(["stop", "-t", "10", container], { allowFailure: true });
  },
};
