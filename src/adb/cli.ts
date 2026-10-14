/**
 * adb binary resolution and the spawn engine. Every adb interaction in the package goes
 * through `runAdb`: a short-lived subprocess, no host shell, bounded capture.
 *
 * No `pi` imports here — this module unit-tests against a stubbed `$ADB`.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { deviceArgs, type ParsedDevice } from "./target.ts";

/** Extra seconds granted after the device-side `timeout` before we kill the local adb. */
export const DEVICE_TIMEOUT_GRACE_SECONDS = 8;
/** Host argv budget (V20: 200 KB fails host-side with "Argument list too long"). */
export const MAX_DEVICE_COMMAND_BYTES = 131072;
/** win32 CreateProcess limit is much smaller than the POSIX ARG_MAX. */
export const MAX_DEVICE_COMMAND_BYTES_WIN32 = 24576;

export interface AdbBinary {
  path: string;
  source: "env" | "sdk" | "path";
}

export class AdbNotInstalledError extends Error {
  readonly candidates: string[];
  constructor(candidates: string[]) {
    super(`adb was not found. Searched: ${candidates.join(", ") || "(no candidates)"} — install Android platform-tools or set $ADB.`);
    this.name = "AdbNotInstalledError";
    this.candidates = candidates;
  }
}

export class CommandTooLongError extends Error {
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(`adb command is ${bytes} bytes, above the ${limit} byte host limit — shorten the command or push a script file first`);
    this.name = "CommandTooLongError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function adbExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "adb.exe" : "adb";
}

/** Ordered search list: `$ADB`, then SDK layouts, then PATH. */
export function adbBinaryCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { path: string; source: AdbBinary["source"] }[] {
  const exe = adbExecutableName(platform);
  const candidates: { path: string; source: AdbBinary["source"] }[] = [];
  if (env.ADB) candidates.push({ path: env.ADB, source: "env" });

  const sdkRoots: string[] = [];
  if (env.ANDROID_HOME) sdkRoots.push(join(env.ANDROID_HOME, "platform-tools", exe));
  if (env.ANDROID_SDK_ROOT) sdkRoots.push(join(env.ANDROID_SDK_ROOT, "platform-tools", exe));
  if (platform === "darwin") sdkRoots.push(join(homedir(), "Library", "Android", "sdk", "platform-tools", exe));
  if (platform === "win32" && env.LOCALAPPDATA) sdkRoots.push(join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", exe));
  for (const path of sdkRoots) candidates.push({ path, source: "sdk" });

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push({ path: join(dir, exe), source: "path" });
  }
  return candidates;
}

export function resolveAdbBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AdbBinary {
  const candidates = adbBinaryCandidates(env, platform);
  if (env.ADB) {
    // An explicit $ADB is authoritative: pointing at a missing file is a user-visible error.
    if (isFile(env.ADB)) return { path: env.ADB, source: "env" };
    throw new AdbNotInstalledError(candidates.map((candidate) => candidate.path));
  }
  for (const candidate of candidates) {
    if (isFile(candidate.path)) return { path: candidate.path, source: candidate.source };
  }
  throw new AdbNotInstalledError(candidates.map((candidate) => candidate.path));
}

/** `adb shell -T -e none [-n] <command>` — the exec transport (V1, V21). */
export function shellArgv(
  device: ParsedDevice,
  transportSerial: string | undefined,
  command: string,
  o: { stdin: boolean },
): string[] {
  return [...deviceArgs(device, transportSerial), "shell", "-T", "-e", "none", ...(o.stdin ? [] : ["-n"]), command];
}

/** `adb exec-out <command>` — byte-exact stdout, but always exits 0 (V3, V4). */
export function execOutArgv(device: ParsedDevice, transportSerial: string | undefined, command: string): string[] {
  return [...deviceArgs(device, transportSerial), "exec-out", command];
}

/** Any other adb subcommand: devices, forward, install, push, pull, get-state, ... */
export function subcommandArgv(device: ParsedDevice, transportSerial: string | undefined, args: string[]): string[] {
  return [...deviceArgs(device, transportSerial), ...args];
}

export interface AdbProcessResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  capHit: boolean;
  /** The child was killed by our abort signal; the caller may treat the op as not executed. */
  aborted: boolean;
}

export interface RunAdbOptions {
  timeoutSeconds: number;
  /** Mandatory: no unbounded capture anywhere (F24). */
  maxCaptureBytes: number;
  stdin?: Buffer;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  /** Test seam for the local kill grace period. */
  graceSeconds?: number;
}

function maxArgvBytes(platform: NodeJS.Platform): number {
  return platform === "win32" ? MAX_DEVICE_COMMAND_BYTES_WIN32 : MAX_DEVICE_COMMAND_BYTES;
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.bytes - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
        continue;
      }
      this.chunks[0] = head.subarray(excess);
      this.bytes -= excess;
      break;
    }
  }

  get size(): number {
    return this.bytes;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Spawn adb with an argv array (never a host shell), a mandatory capture ceiling, and a
 * local kill that backs up the device-side `timeout`.
 */
export function runAdb(argv: string[], o: RunAdbOptions, platform: NodeJS.Platform = process.platform): Promise<AdbProcessResult> {
  const limit = maxArgvBytes(platform);
  const bytes = Buffer.byteLength(argv.join(" "), "utf8");
  if (bytes > limit) return Promise.reject(new CommandTooLongError(bytes, limit));
  if (!Number.isFinite(o.maxCaptureBytes) || o.maxCaptureBytes < 1) {
    return Promise.reject(new TypeError("runAdb requires a positive maxCaptureBytes"));
  }

  let binary: AdbBinary;
  try {
    binary = resolveAdbBinary(process.env, platform);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    // shell:false: no host quoting, no host PATH surprise.
    const child = spawn(binary.path, argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = o.onStdout ? undefined : new TailBuffer(o.maxCaptureBytes);
    const stderr = o.onStderr ? undefined : new TailBuffer(o.maxCaptureBytes);
    let timedOut = false;
    let aborted = false;
    let capHit = false;
    let settled = false;

    const kill = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
      // A killed adb client can leave a grandchild holding the inherited pipes, which would
      // keep `close` from firing; destroying our ends unblocks the result.
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
    }, (o.timeoutSeconds + (o.graceSeconds ?? DEVICE_TIMEOUT_GRACE_SECONDS)) * 1000);

    const onAbort = () => {
      aborted = true;
      kill("SIGKILL");
    };
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener("abort", onAbort, { once: true });
    }

    const capture = (
      stream: NodeJS.ReadableStream,
      sink: TailBuffer | undefined,
      relay: ((chunk: Buffer) => void) | undefined,
      onCap: () => void,
    ) => {
      stream.on("error", () => {
        /* destroyed by the cap/timeout kill */
      });
      stream.on("data", (chunk: Buffer) => {
        relay?.(chunk);
        if (!sink) return;
        if (sink.size + chunk.length > o.maxCaptureBytes) {
          capHit = true;
          onCap();
        }
        sink.push(chunk);
      });
    };
    capture(child.stdout!, stdout, o.onStdout, () => kill("SIGKILL"));
    capture(child.stderr!, stderr, o.onStderr, () => kill("SIGKILL"));

    child.stdin.on("error", () => {
      /* the child is already gone */
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      rejectPromise(error.code === "ENOENT" ? new AdbNotInstalledError([binary.path]) : error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode: code,
        stdout: stdout?.toBuffer() ?? Buffer.alloc(0),
        stderr: stderr?.toBuffer() ?? Buffer.alloc(0),
        timedOut,
        capHit,
        aborted,
      });
    });

    if (o.stdin) child.stdin.end(o.stdin);
    else child.stdin.end();
  });
}
