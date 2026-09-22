import { spawn } from "node:child_process";
import { getgid, getuid } from "node:process";
import { basename } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { CommandSpec } from "./types.ts";

export type ExecResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

function runProcess(command: string, args: string[], options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
} = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); options.onStdout?.(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); options.onStderr?.(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => finish({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut }));
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    timer?.unref?.();
  });
}

export class DockerWorkspace {
  static async verifyImage(ref: string, expectedId: string, expectedPlatform: string): Promise<void> {
    const result = await runProcess("docker", ["image", "inspect", ref, "--format", "{{.Id}} {{.Os}}/{{.Architecture}}"], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`docker image inspect failed for ${ref}: ${result.stderr || result.stdout}`);
    const actual = result.stdout.trim();
    if (actual !== `${expectedId} ${expectedPlatform}`) throw new Error(`docker image mismatch for ${ref}: expected ${expectedId} ${expectedPlatform}, got ${actual}`);
  }

  readonly name: string;
  readonly image: string;
  readonly workspace: string;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(input: { name: string; image: string; workspace: string }) {
    this.name = input.name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
    this.image = input.image;
    this.workspace = input.workspace;
  }

  async start(): Promise<void> {
    const uid = typeof getuid === "function" ? getuid() : 1000;
    const gid = typeof getgid === "function" ? getgid() : 1000;
    const mount = `type=bind,src=${this.workspace},dst=/workspace`;
    const args = [
      "run", "--detach", "--rm", "--name", this.name,
      "--network", "none", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
      "--tmpfs", "/run:rw,nosuid,nodev,size=16m",
      "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "512", "--cpus", "2",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${uid}:${gid}`, "--workdir", "/workspace",
      "--env", "HOME=/tmp", "--env", "CI=1", "--env", "PYTHONDONTWRITEBYTECODE=1",
      "--mount", mount, this.image, "sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
    ];
    const result = await runProcess("docker", args, { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new Error(`docker run failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  async exec(argv: string[], options: { signal?: AbortSignal; timeoutMs?: number; onData?: (chunk: Buffer) => void } = {}): Promise<ExecResult> {
    if (this.stopped) throw new Error("container stopped; command was not executed");
    options.signal?.throwIfAborted();
    let aborting = false;
    const abort = () => {
      aborting = true;
      void this.stop();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => { aborting = true; void this.stop(); }, options.timeoutMs);
    timeout?.unref?.();
    try {
      const result = await runProcess("docker", ["exec", "--workdir", "/workspace", this.name, ...argv], {
        onStdout: options.onData,
        onStderr: options.onData,
      });
      return { ...result, timedOut: result.timedOut || (aborting && !options.signal?.aborted) };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async command(spec: CommandSpec, extraArgs: string[] = [], signal?: AbortSignal): Promise<ExecResult> {
    return this.exec([...spec.argv, ...extraArgs], { signal, timeoutMs: spec.timeoutMs ?? 600_000 });
  }

  bashOperations(): BashOperations {
    return {
      exec: async (command, _cwd, options) => {
        const seconds = options.timeout;
        if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error("timeout must be a positive number of seconds");
        const argv = seconds === undefined
          ? ["bash", "-lc", command]
          : ["timeout", "--kill-after=1s", `${seconds}s`, "bash", "-lc", command];
        const result = await this.exec(argv, {
          signal: options.signal,
          onData: options.onData,
        });
        if (result.exitCode === 124 || result.exitCode === 137) throw new Error(`Command timed out or was killed (timeout ${seconds ?? "unset"} seconds)`);
        if (result.exitCode === null) throw new Error("container command terminated without an exit code");
        return { exitCode: result.exitCode };
      },
    };
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = (async () => {
      const result = await runProcess("docker", ["stop", "--time", "1", this.name], { timeoutMs: 15_000 });
      if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) {
        throw new Error(`failed to stop container ${basename(this.name)}: ${result.stderr || result.stdout}`);
      }
    })();
    return this.stopPromise;
  }
}
