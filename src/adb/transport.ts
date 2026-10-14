/**
 * AdbTransport: every device command the package can run, in one auditable file (plan §5.4).
 *
 * Two invariants hold throughout:
 *  - device commands are built as a single string wrapped by `cd -- <cwd> && timeout … sh -c …`
 *    and handed to adb as ONE argv element (no host shell, V21);
 *  - `exec-out` is byte-only and always exits 0 (V3), so every byte path is gated by `stat`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, posix } from "node:path";
import { runAdb, execOutArgv, shellArgv, subcommandArgv, type AdbProcessResult } from "./cli.ts";
import { classifyAdbError, CONTROL_MAX_CAPTURE_BYTES, type DeviceCapabilities } from "./device.ts";
import { saveOutput } from "./exec-output.ts";
import { quote } from "../shell.ts";
import type { ParsedDevice } from "./target.ts";

/** Same 30s default the previous transport used (index.ts:128). */
export const DEFAULT_DEVICE_TIMEOUT_SECONDS = 30;
/** `install` streams an APK; the model cannot shorten that. */
export const DEFAULT_INSTALL_TIMEOUT_SECONDS = 300;
/** Scratch directory for atomic writes, inside the target's parent (plan §3 exception). */
export const STAGING_DIR_NAME = ".pi-staging";

export interface DeviceForwardSpec {
  localPort: number;
  target: "tcp" | "localabstract" | "dev" | "jdwp";
  name: string;
}

// Names may contain `:` (jdwp names are `<process>:<pid>`) but never whitespace: `adb forward
// --list` is whitespace-delimited, so a space would make a forward unreadable (V24).
const FORWARD_PATTERN = /^(\d+):(tcp|localabstract|dev|jdwp):([A-Za-z0-9._%+/-][A-Za-z0-9._%+/:@-]*)$/;

export function parseForwardSpec(value: string): DeviceForwardSpec {
  const match = FORWARD_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid forward spec ${quote(value)} — expected <localPort>:<tcp|localabstract|dev|jdwp>:<name>, e.g. 18080:tcp:8080`);
  }
  const localPort = Number(match[1]);
  if (localPort < 1 || localPort > 65535) throw new Error(`Invalid forward local port ${localPort} (expected 1-65535)`);
  return { localPort, target: match[2] as DeviceForwardSpec["target"], name: match[3] };
}

export function serializeForwardSpec(spec: DeviceForwardSpec): string {
  return `${spec.localPort}:${spec.target}:${spec.name}`;
}

export function forwardSpecArgs(spec: DeviceForwardSpec): string[] {
  return [`tcp:${spec.localPort}`, `${spec.target}:${spec.name}`];
}

/** Device-side timeout wrapper: toybox `timeout` rejects GNU long options (V8), accepts -k/-s (V9). */
export function withDeviceTimeout(command: string, seconds: number, supported: boolean): string {
  if (!supported) return command;
  return `timeout -k 5 -s TERM ${seconds} sh -c ${quote(command)}`;
}

export function buildDeviceCommand(
  cwd: string,
  command: string,
  o: { timeoutSeconds: number; hasTimeout: boolean },
): string {
  return `cd -- ${quote(cwd)} && ${withDeviceTimeout(command, o.timeoutSeconds, o.hasTimeout)}`;
}

export interface DeviceStat {
  kind: "file" | "dir" | "symlink" | "other";
  mode: string;
  size: number;
}

const STAT_KINDS: Record<string, DeviceStat["kind"]> = {
  "regular file": "file",
  "regular empty file": "file",
  directory: "dir",
  "symbolic link": "symlink",
};

/** Follows symlinks and never fails: one spawn, `ABSENT` when the path is gone (V14). */
export const STAT_COMMAND = (devicePath: string): string =>
  `stat -L -c '%F|%a|%s' -- ${quote(devicePath)} 2>/dev/null || echo ABSENT`;

export function parseStatOutput(text: string): DeviceStat | undefined {
  const line = text.trim().split("\n").pop() ?? "";
  if (!line || line === "ABSENT") return undefined;
  const [kind, mode, size] = line.split("|");
  const parsedSize = Number(size);
  if (mode === undefined || size === undefined || !Number.isFinite(parsedSize)) return undefined;
  return {
    kind: STAT_KINDS[kind] ?? "other",
    mode,
    size: parsedSize,
  };
}

/** chmod only ever receives a validated octal string (V13, F21). */
export const MODE_PATTERN = /^[0-7]{3,4}$/;

export interface ExecResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** The child was killed before it emitted anything: the command almost certainly did not run. */
  notExecuted: boolean;
}

export type MethodClass = "read" | "mutate";

export type AdbTransportMethod =
  | "stat"
  | "readTextRange"
  | "readBytes"
  | "sampleBytes"
  | "exec"
  | "writeBytes"
  | "push"
  | "pull"
  | "forward"
  | "unforward"
  | "listForwards"
  | "screencap"
  | "install"
  | "uninstall";

/**
 * Retry policy source of truth (F7): only `read` operations may be retried automatically.
 * `pull` mutates the host filesystem and `forward`/`unforward` mutate adb-server state.
 */
export const METHOD_CLASS: Record<AdbTransportMethod, MethodClass> = {
  stat: "read",
  readTextRange: "read",
  readBytes: "read",
  sampleBytes: "read",
  listForwards: "read",
  screencap: "read",
  exec: "mutate",
  writeBytes: "mutate",
  push: "mutate",
  pull: "mutate",
  forward: "mutate",
  unforward: "mutate",
  install: "mutate",
  uninstall: "mutate",
};

export class DeviceCommandError extends Error {
  readonly exitCode: number | null;
  readonly deviceStderr: string;
  readonly timedOut: boolean;
  constructor(message: string, exitCode: number | null, deviceStderr: string, timedOut = false) {
    super(message);
    this.name = "DeviceCommandError";
    this.exitCode = exitCode;
    this.deviceStderr = deviceStderr;
    this.timedOut = timedOut;
  }
}

export class InstallFailure extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(`adb install failed [${code}]: ${message}${hint ? ` — ${hint}` : ""}`);
    this.name = "InstallFailure";
    this.code = code;
    this.hint = hint;
  }
}

const INSTALL_HINTS: Record<string, string> = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE:
    "The installed package is signed with a different key. Uninstall it first (adb action=\"uninstall\") only if losing its data is acceptable.",
  INSTALL_FAILED_VERSION_DOWNGRADE:
    "A higher versionCode is already installed. Remove it or raise versionCode; this tool never adds -d implicitly.",
  INSTALL_FAILED_SHARED_USER_INCOMPATIBLE:
    "The android:sharedUserId signature set does not match the device's existing one.",
  INSTALL_FAILED_ABORTED: "Install was aborted, often by the user or by insufficient storage.",
  INSTALL_FAILED_INSUFFICIENT_STORAGE: "Free space on the device, or install to external storage explicitly.",
  INSTALL_PARSE_FAILED_NOT_APK: "The file is not a valid APK at that path.",
  INSTALL_FAILED_INVALID_URI: "The APK path was not readable by the installer.",
};

export function parseInstallFailure(output: string): InstallFailure | undefined {
  const match = /Failure \[([A-Z_]+)(?::\s*([^\]]*))?\]/.exec(output);
  if (!match) return undefined;
  const code = match[1];
  const message = (match[2] ?? code).trim();
  return new InstallFailure(code, message, INSTALL_HINTS[code] ?? "");
}

export interface TransportLimits {
  imageMaxBytes: number;
  spillCapBytes: number;
}

export interface ExecOptions {
  timeoutSeconds: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  maxCaptureBytes?: number;
  stdin?: Buffer;
}

export class AdbTransport {
  readonly device: ParsedDevice;
  readonly transportSerial: string;
  readonly capabilities: DeviceCapabilities;
  readonly limits: TransportLimits;
  private readonly outputDir: string | undefined;

  // Node's type-stripping rejects parameter properties, so fields are assigned explicitly.
  constructor(
    device: ParsedDevice,
    transportSerial: string,
    capabilities: DeviceCapabilities,
    limits: TransportLimits,
    outputDir?: string,
  ) {
    this.device = device;
    this.transportSerial = transportSerial;
    this.capabilities = capabilities;
    this.limits = limits;
    this.outputDir = outputDir;
  }

  // --- internals (not part of the public surface asserted by METHOD_CLASS) ------------------

  async #shell(
    deviceCommand: string,
    o: { timeoutSeconds?: number; stdin?: Buffer; signal?: AbortSignal; maxCaptureBytes?: number } = {},
  ): Promise<AdbProcessResult> {
    return runAdb(shellArgv(this.device, this.transportSerial, deviceCommand, { stdin: !!o.stdin }), {
      timeoutSeconds: o.timeoutSeconds ?? DEFAULT_DEVICE_TIMEOUT_SECONDS,
      maxCaptureBytes: o.maxCaptureBytes ?? CONTROL_MAX_CAPTURE_BYTES,
      stdin: o.stdin,
      signal: o.signal,
    });
  }

  async #must(deviceCommand: string, context: string, o: { stdin?: Buffer; timeoutSeconds?: number } = {}): Promise<string> {
    const result = await this.#shell(deviceCommand, o);
    if (result.timedOut) {
      throw new DeviceCommandError(`${context}: timed out`, null, "", true);
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      throw new DeviceCommandError(
        `${context}: ${stderr || `device command exited with code ${result.exitCode}`}`,
        result.exitCode,
        stderr,
      );
    }
    return result.stdout.toString("utf8");
  }

  /** Canonical write destination: resolves `..`, parent symlinks, and the file symlink (F16). */
  async #resolveReal(devicePath: string): Promise<string> {
    const result = await this.#shell(`readlink -f ${quote(devicePath)}`);
    const resolved = result.stdout.toString("utf8").trim();
    // A path whose parent does not exist yet cannot be resolved; keep the caller's spelling.
    return result.exitCode === 0 && resolved ? resolved : devicePath;
  }

  async #assertFile(devicePath: string, maxBytes: number): Promise<DeviceStat> {
    const info = await this.stat(devicePath);
    if (!info) throw new Error(`No such device file: ${devicePath}`);
    if (info.kind === "dir") throw new Error(`${devicePath} is a directory (mode ${info.mode})`);
    if (info.size > maxBytes) {
      throw new Error(
        `${devicePath} is ${info.size} bytes, above the ${maxBytes} byte cap — use adb action="pull" for large files`,
      );
    }
    return info;
  }

  async #execOut(command: string, timeoutSeconds: number): Promise<Buffer> {
    const wrapped = withDeviceTimeout(command, timeoutSeconds, this.capabilities.hasTimeout);
    const result = await runAdb(execOutArgv(this.device, this.transportSerial, wrapped), {
      timeoutSeconds,
      maxCaptureBytes: this.limits.imageMaxBytes,
    });
    if (result.stdout.length > this.limits.imageMaxBytes) {
      throw new Error(`Device returned more than the ${this.limits.imageMaxBytes} byte cap`);
    }
    return result.stdout;
  }

  // --- read class --------------------------------------------------------------------------

  async stat(devicePath: string): Promise<DeviceStat | undefined> {
    const output = await this.#shell(STAT_COMMAND(devicePath));
    // The command swallows `stat`'s own error and prints ABSENT, so a non-zero exit here means
    // the device or the daemon failed — reporting that as "no such file" would be a lie (F19).
    if (output.timedOut) throw new DeviceCommandError(`could not stat ${devicePath}: timed out`, null, "", true);
    if (output.exitCode !== 0) {
      const stderr = output.stderr.toString("utf8").trim();
      throw new DeviceCommandError(
        `could not stat ${devicePath}: ${stderr || `device command exited with code ${output.exitCode}`}`,
        output.exitCode,
        stderr,
      );
    }
    return parseStatOutput(output.stdout.toString("utf8"));
  }

  /** `sed -n 'a,bp'` through `shell -T`: byte-identical to the file, with a real exit code (V22). */
  async readTextRange(devicePath: string, startLine: number, endLine: number, maxBytes: number): Promise<Buffer> {
    await this.#assertFile(devicePath, Number.MAX_SAFE_INTEGER);
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.max(start, Math.floor(endLine));
    const command = `sed -n '${start},${end}p' ${quote(devicePath)} | head -c ${Math.max(1, Math.floor(maxBytes))}`;
    // Bytes are kept as bytes: a UTF-8 round trip would corrupt non-text payloads.
    const result = await this.#shell(command);
    if (result.timedOut) throw new DeviceCommandError(`could not read ${devicePath}:${start}-${end}: timed out`, null, "", true);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      throw new DeviceCommandError(
        `could not read ${devicePath}:${start}-${end}: ${stderr || `device command exited with code ${result.exitCode}`}`,
        result.exitCode,
        stderr,
      );
    }
    return result.stdout;
  }

  async readBytes(devicePath: string, maxBytes: number): Promise<Buffer> {
    const info = await this.#assertFile(devicePath, maxBytes);
    if (info.size === 0) return Buffer.alloc(0);
    const bytes = await this.#execOut(`head -c ${maxBytes} ${quote(devicePath)}`, DEFAULT_DEVICE_TIMEOUT_SECONDS);
    if (bytes.length === 0 && info.size > 0) {
      throw new Error(`Device produced no bytes for ${devicePath} (${info.size} bytes per stat) — SELinux may deny the shell user`);
    }
    return bytes;
  }

  /**
   * `exec-out screencap -p` (V31): a single-purpose binary capture rather than a general
   * exec-out escape hatch, so nothing caller-supplied can reach the device as a "read".
   */
  async screencap(timeoutSeconds = DEFAULT_DEVICE_TIMEOUT_SECONDS): Promise<Buffer> {
    return this.#execOut("screencap -p", timeoutSeconds);
  }

  async sampleBytes(devicePath: string, count: number): Promise<Buffer> {
    await this.#assertFile(devicePath, Number.MAX_SAFE_INTEGER);
    return this.#execOut(`head -c ${Math.max(1, Math.floor(count))} ${quote(devicePath)}`, DEFAULT_DEVICE_TIMEOUT_SECONDS);
  }

  // --- mutate class ------------------------------------------------------------------------

  async exec(command: string, cwd: string, o: ExecOptions): Promise<ExecResult> {
    const deviceCommand = buildDeviceCommand(cwd, command, {
      timeoutSeconds: o.timeoutSeconds,
      hasTimeout: this.capabilities.hasTimeout,
    });
    let bytesSeen = 0;
    // Only stream when the caller wants chunks: passing a sink would make runAdb skip
    // accumulation and return an empty stdout for every non-streaming caller.
    const stream = o.onStdout
      ? (chunk: Buffer) => {
          bytesSeen += chunk.length;
          o.onStdout?.(chunk);
        }
      : undefined;
    const result = await runAdb(shellArgv(this.device, this.transportSerial, deviceCommand, { stdin: false }), {
      timeoutSeconds: o.timeoutSeconds,
      maxCaptureBytes: o.maxCaptureBytes ?? CONTROL_MAX_CAPTURE_BYTES,
      signal: o.signal,
      onStdout: stream,
      onStderr: o.onStderr,
    });
    if (!stream) bytesSeen = result.stdout.length;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      notExecuted: (result.aborted || result.timedOut) && bytesSeen === 0,
    };
  }

  /**
   * Atomic write (plan §5.4): stage inside the target's parent, chmod before the rename so the
   * file is never briefly wrong-mode, then `mv -f`. Falls back to `cat >` when the parent cannot
   * host a staging directory, and reports that in the result (F15).
   */
  async writeBytes(devicePath: string, data: Buffer): Promise<{ atomic: boolean }> {
    const targetStat = await this.stat(devicePath);
    // `stat -L` follows links (V14), so a symlinked target must be resolved explicitly: without
    // this, `mv -f` would replace the link and orphan its file (F16).
    const target = await this.#resolveReal(devicePath);
    if (targetStat && targetStat.kind !== "file") {
      // `mv -f <staged> <dir>` would silently drop the file *inside* the directory (F16 family).
      throw new Error(
        targetStat.kind === "dir"
          ? `${devicePath} is a directory (mode ${targetStat.mode}) — refusing to overwrite it`
          : `${devicePath} is a ${targetStat.kind}, not a regular file — refusing to write to it`,
      );
    }
    const parent = posix.dirname(target) || "/";
    const desiredMode = targetStat ? targetStat.mode : "644";
    const mode = MODE_PATTERN.test(desiredMode) ? desiredMode : "644";

    const stagingDir = posix.join(parent, STAGING_DIR_NAME);
    const staged = posix.join(stagingDir, `w-${randomBytes(8).toString("hex")}`);
    const prepared = await this.#shell(
      `mkdir -p ${quote(stagingDir)} && find ${quote(stagingDir)} -type f -mmin +60 -delete 2>/dev/null; test -w ${quote(stagingDir)} && echo OK`,
    );
    const modeWarning = MODE_PATTERN.test(desiredMode) ? "" : ` (ignored invalid mode '${desiredMode}', used 644)`;

    if (prepared.exitCode !== 0 || !prepared.stdout.toString("utf8").includes("OK")) {
      // Parent accepts a file but not a directory: last-resort non-atomic write (F15).
      await this.#must(`cat > ${quote(target)}`, `could not write ${target}`, { stdin: data });
      return { atomic: false };
    }

    const hostTemp = saveOutput(data, this.outputDir, basename(target));
    let failure: unknown;
    try {
      const pushed = await runAdb(
        subcommandArgv(this.device, this.transportSerial, ["push", hostTemp, staged]),
        { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
      );
      if (pushed.exitCode !== 0) {
        const stderr = pushed.stderr.toString("utf8").trim();
        throw new DeviceCommandError(
          `could not stage ${target}: ${stderr || `adb push exited ${pushed.exitCode}`}`,
          pushed.exitCode,
          stderr,
        );
      }
      await this.#must(
        `chmod ${mode} ${quote(staged)} && mv -f ${quote(staged)} ${quote(target)}`,
        `could not commit ${target}${modeWarning}`,
      );
    } catch (error) {
      failure = error;
    }

    // `finally` cannot throw without hiding the write error, so cleanup runs after the catch
    // and only reports residue in addition to the original failure (F13).
    rmSync(hostTemp, { force: true });
    const cleaned = await this.#shell(`rm -f ${quote(staged)} 2>/dev/null; rmdir ${quote(stagingDir)} 2>/dev/null; test ! -e ${quote(staged)}`);
    const residue = cleaned.exitCode !== 0 ? `${staged} could not be removed` : undefined;
    if (failure) {
      const detail = residue ? ` and ${residue}` : "";
      const message = failure instanceof Error ? failure.message : String(failure);
      throw new DeviceCommandError(`${message}${detail}`, null, residue ?? "", false);
    }
    // Committed cleanly. If `residue` is set, the scratch file outlived us and the next write
    // into this directory garbage-collects it (F14).
    return { atomic: true };
  }

  /** `adb push` — files only; a directory destination needs a trailing slash (plan §5.4). */
  async push(hostPath: string, devicePath: string, o: { overwrite?: boolean } = {}): Promise<void> {
    if (!existsSync(hostPath) || !statSync(hostPath).isFile()) {
      throw new Error(`Host file not found: ${hostPath}`);
    }
    const { destination, existing } = await this.#resolvePushTarget(hostPath, devicePath, o.overwrite === true);
    if (existing?.kind === "file") {
      // Pushing over an existing file uses the same staging dance as `writeBytes` (§5.4): the
      // replacement is atomic and keeps the destination's mode instead of resetting it.
      await this.writeBytes(destination, readFileSync(hostPath));
      return;
    }
    const pushed = await runAdb(
      subcommandArgv(this.device, this.transportSerial, ["push", hostPath, destination]),
      { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
    );
    if (pushed.exitCode !== 0) {
      const stderr = pushed.stderr.toString("utf8").trim();
      throw new DeviceCommandError(`adb push failed: ${stderr || `exit ${pushed.exitCode}`}`, pushed.exitCode, stderr);
    }
  }

  async #resolvePushTarget(
    hostPath: string,
    devicePath: string,
    overwrite: boolean,
  ): Promise<{ destination: string; existing: DeviceStat | undefined }> {
    const info = await this.stat(devicePath);
    if (!info) return { destination: devicePath, existing: undefined };
    if (info.kind === "dir") {
      if (!devicePath.endsWith("/")) {
        throw new Error(`${devicePath} is a directory — end the device path with '/' to push into it`);
      }
      return { destination: posix.join(devicePath, basename(hostPath)), existing: info };
    }
    if (!overwrite) {
      throw new Error(`${devicePath} already exists (mode ${info.mode}, ${info.size} bytes) — pass overwrite: true to replace it`);
    }
    return { destination: devicePath, existing: info };
  }

  async pull(devicePath: string, hostPath: string, o: { overwrite?: boolean } = {}): Promise<void> {
    const info = await this.stat(devicePath);
    if (!info) throw new Error(`No such device file: ${devicePath}`);
    if (info.kind === "dir") {
      throw new Error(`${devicePath} is a directory (mode ${info.mode}) — pull files one at a time, or tar it with bash first`);
    }
    if (existsSync(hostPath) && o.overwrite !== true) {
      throw new Error(`Refusing to overwrite existing host file ${hostPath} — pass overwrite: true`);
    }
    const pulled = await runAdb(
      subcommandArgv(this.device, this.transportSerial, ["pull", devicePath, hostPath]),
      { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
    );
    if (pulled.exitCode !== 0) {
      const stderr = pulled.stderr.toString("utf8").trim();
      throw new DeviceCommandError(`adb pull failed: ${stderr || `exit ${pulled.exitCode}`}`, pulled.exitCode, stderr);
    }
  }

  async forward(spec: DeviceForwardSpec): Promise<void> {
    const result = await runAdb(
      subcommandArgv(this.device, this.transportSerial, ["forward", "--no-rebind", ...forwardSpecArgs(spec)]),
      { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
    );
    if (result.exitCode === 0) return;
    const stderr = result.stderr.toString("utf8").trim();
    const failure = classifyAdbError(stderr);
    const detail = failure === "forward-bind-conflict" || failure === "forward-rebind" ? ` (${failure})` : "";
    throw new DeviceCommandError(
      `could not forward local port ${spec.localPort} to ${spec.target}:${spec.name}${detail}: ${stderr || `exit ${result.exitCode}`}. Run \`adb forward --list\` to see who owns it.`,
      result.exitCode,
      stderr,
    );
  }

  async unforward(localPort: number): Promise<void> {
    const result = await runAdb(
      subcommandArgv(this.device, this.transportSerial, ["forward", "--remove", `tcp:${localPort}`]),
      { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      throw new DeviceCommandError(`could not remove forward tcp:${localPort}: ${stderr || `exit ${result.exitCode}`}`, result.exitCode, stderr);
    }
  }

  async listForwards(): Promise<DeviceForwardSpec[]> {
    const output = await runAdb(
      subcommandArgv(this.device, this.transportSerial, ["forward", "--list"]),
      { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
    );
    if (output.exitCode !== 0) return [];
    const specs: DeviceForwardSpec[] = [];
    for (const line of output.stdout.toString("utf8").split("\n")) {
      const fields = line.trim().split(/\s+/);
      // `serial local tcp:remote` — only this device's rows are ours to consider.
      if (fields.length < 3 || fields[0] !== this.transportSerial) continue;
      const local = /^tcp:(\d+)$/.exec(fields[1] ?? "");
      const remote = /^(tcp|localabstract|dev|jdwp):(.+)$/.exec(fields[2] ?? "");
      if (!local || !remote) continue;
      specs.push({ localPort: Number(local[1]), target: remote[1] as DeviceForwardSpec["target"], name: remote[2] });
    }
    return specs;
  }

  async install(hostApk: string, o: { timeoutSeconds?: number } = {}): Promise<void> {
    if (!existsSync(hostApk) || !statSync(hostApk).isFile()) throw new Error(`Host APK not found: ${hostApk}`);
    const result = await runAdb(
      subcommandArgv(this.device, this.transportSerial, ["install", hostApk]),
      {
        timeoutSeconds: o.timeoutSeconds ?? DEFAULT_INSTALL_TIMEOUT_SECONDS,
        maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES,
      },
    );
    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
    if (result.exitCode === 0 && /Success/.test(output)) return;
    const failure = parseInstallFailure(output);
    if (failure) throw failure;
    throw new DeviceCommandError(
      `adb install failed: ${output.trim() || `exit ${result.exitCode}`}`,
      result.exitCode,
      result.stderr.toString("utf8").trim(),
    );
  }

  async uninstall(packageName: string): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
      throw new Error(`Invalid package name ${quote(packageName)}`);
    }
    const result = await runAdb(
      subcommandArgv(this.device, this.transportSerial, ["uninstall", packageName]),
      { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
    );
    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
    if (result.exitCode === 0 && /Success/.test(output)) return;
    throw new DeviceCommandError(
      `adb uninstall ${packageName} failed: ${output.trim() || `exit ${result.exitCode}`}`,
      result.exitCode,
      result.stderr.toString("utf8").trim(),
    );
  }
}
