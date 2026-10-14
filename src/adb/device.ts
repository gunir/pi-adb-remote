/**
 * Device discovery, identity resolution, capability probe, and adb failure classification.
 *
 * There is no long-lived connection object to notice a disconnect, so liveness is a probed
 * state and device *identity* (`ro.serialno`) is resolved to a volatile transport serial on
 * every connect (plan §4.3, V28).
 */

import { runAdb, shellArgv, subcommandArgv, type AdbProcessResult } from "./cli.ts";
import type { ParsedDevice } from "./target.ts";

/** Cap for control-plane output (`devices`, `getprop`, `get-state`): far above any real payload. */
export const CONTROL_MAX_CAPTURE_BYTES = 1_048_576;
/** `adb start-server` and `wait-for-device` budget (F18). */
export const SERVER_START_SECONDS = 15;

export type DeviceState =
  | "device"
  | "offline"
  | "unauthorized"
  | "authorizing"
  | "absent"
  | "unknown";

export interface DeviceEntry {
  serial: string;
  state: DeviceState;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
}

export interface DeviceIdentity {
  identity: string;
  props: {
    model?: string;
    product?: string;
    apiLevel?: string;
    release?: string;
    abi?: string;
    buildType?: string;
  };
}

export interface DeviceCapabilities {
  shellV2: boolean;
  exitCodes: boolean;
  stderrSeparation: boolean;
  hasTimeout: boolean;
  hasSed: boolean;
  hasStat: boolean;
  hasGrep: boolean;
  hasFind: boolean;
  uid: string;
}

export type AdbFailure =
  | "absent"
  | "offline"
  | "unauthorized"
  | "ambiguous"
  | "identity-collision"
  | "server-down"
  | "forward-bind-conflict"
  | "forward-rebind"
  | "other";

export type IdentityResolution =
  | { kind: "resolved"; transportSerial: string; entry: DeviceEntry }
  | { kind: "absent"; candidates: DeviceEntry[] }
  | { kind: "collision"; matches: DeviceEntry[] }
  /** Multiple devices attached and the endpoint names none of them (`adb`, `adb -d`, `adb -e`). */
  | { kind: "ambiguous"; candidates: DeviceEntry[] };

export class AdbCommandError extends Error {
  readonly failure: AdbFailure;
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, failure: AdbFailure, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "AdbCommandError";
    this.failure = failure;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** adb client banners: informational noise that must never reach a parser (F18). */
const BANNER_PATTERNS = [
  /^\* daemon not running; starting now at tcp:\d+$/,
  /^\* daemon started successfully$/,
  /^\* waiting for device.*$/,
  /^adb server version \(\d+\) doesn't match this client \(\d+\).*$/,
];

/** Strips the autostart / version-mismatch banner lines adb writes to stderr (F18). */
export function stripAdbBanner(text: string): string {
  return text
    .split("\n")
    .filter((line) => !BANNER_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n");
}

function globalArgs(device: ParsedDevice): string[] {
  // `devices`/`start-server` are server commands: a device selector would be meaningless.
  return device.serverHost
    ? ["-H", device.serverHost, "-P", String(device.serverPort ?? 5037)]
    : [];
}

function fail(result: AdbProcessResult, context: string): never {
  const raw = result.stderr.toString("utf8");
  const stderr = stripAdbBanner(raw).trim();
  const failure = classifyAdbError(`${context}\n${raw}`);
  throw new AdbCommandError(
    `${context}: ${stderr || `adb exited with code ${result.exitCode}`}`,
    failure,
    result.exitCode,
    stderr,
  );
}

async function control(device: ParsedDevice, args: string[], timeoutSeconds = SERVER_START_SECONDS): Promise<AdbProcessResult> {
  // Server commands: never pass a device selector (an identity endpoint has none to pass, V28).
  return runAdb([...globalArgs(device), ...args], {
    timeoutSeconds,
    maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES,
  });
}

export function parseDevicesOutput(text: string): DeviceEntry[] {
  const entries: DeviceEntry[] = [];
  for (const raw of stripAdbBanner(text).split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line === "List of devices attached" || line === "* daemon still not running") continue;
    const fields = line.split(/\s+/);
    const [serial, state, ...rest] = fields;
    if (!serial || !state) continue;
    const entry: DeviceEntry = { serial, state: normalizeState(state) };
    for (const field of rest) {
      const split = field.indexOf(":");
      if (split < 1) continue;
      const key = field.slice(0, split);
      const value = field.slice(split + 1);
      if (key === "product") entry.product = value;
      else if (key === "model") entry.model = value;
      else if (key === "device") entry.device = value;
      else if (key === "transport_id") entry.transportId = value;
    }
    entries.push(entry);
  }
  return entries;
}

function normalizeState(state: string): DeviceState {
  switch (state) {
    case "device":
      return "device";
    case "offline":
      return "offline";
    case "unauthorized":
      return "unauthorized";
    case "authorizing":
      return "authorizing";
    default:
      return "unknown";
  }
}

export async function listDevices(device: ParsedDevice): Promise<DeviceEntry[]> {
  const result = await control(device, ["devices", "-l"]);
  if (result.exitCode !== 0) fail(result, "adb devices failed");
  return parseDevicesOutput(result.stdout.toString("utf8"));
}

export async function getState(device: ParsedDevice, transportSerial: string): Promise<DeviceState> {
  const result = await runAdb(subcommandArgv(device, transportSerial, ["get-state"]), {
    timeoutSeconds: SERVER_START_SECONDS,
    maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES,
  });
  const stderr = stripAdbBanner(result.stderr.toString("utf8"));
  if (result.exitCode !== 0) {
    if (classifyAdbError(stderr) === "absent") return "absent";
    fail(result, "adb get-state failed");
  }
  const text = stripAdbBanner(result.stdout.toString("utf8")).trim();
  if (!text) return "absent";
  const state = normalizeState(text.split(/\s+/)[0]);
  return state === "unknown" ? "unknown" : state;
}

const PROP_FIELDS: [string, string][] = [
  ["identity", "ro.serialno"],
  ["fallbackIdentity", "ro.boot.serialno"],
  ["model", "ro.product.model"],
  ["product", "ro.product.name"],
  ["apiLevel", "ro.build.version.sdk"],
  ["release", "ro.build.version.release"],
  ["abi", "ro.product.cpu.abi"],
  ["buildType", "ro.build.type"],
];

/** One spawn, sentinel-delimited (V14/V13 pattern: fewer round trips). */
export function identityPropsCommand(): string {
  return PROP_FIELDS.map(([key, prop]) => `echo "@${key}"; getprop ${prop}`).join("; ");
}

export function parseIdentityProps(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  let key: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@")) {
      key = line.slice(1).trim();
      continue;
    }
    if (key && !(key in values)) values[key] = line.trim();
  }
  return values;
}

export async function readIdentityProps(
  device: ParsedDevice,
  transportSerial: string,
  transportId?: string,
): Promise<DeviceIdentity> {
  const result = await runAdb(
    shellArgv(device, transportSerial, identityPropsCommand(), { stdin: false }),
    { timeoutSeconds: SERVER_START_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
  );
  if (result.exitCode !== 0) fail(result, "could not read device identity");
  const values = parseIdentityProps(result.stdout.toString("utf8"));
  const identity =
    values.identity || values.fallbackIdentity || `transport:${transportId ?? transportSerial}`;
  return {
    identity,
    props: {
      model: values.model || undefined,
      product: values.product || undefined,
      apiLevel: values.apiLevel || undefined,
      release: values.release || undefined,
      abi: values.abi || undefined,
      buildType: values.buildType || undefined,
    },
  };
}

export interface ResolveIdentityDeps {
  listDevices: (device: ParsedDevice) => Promise<DeviceEntry[]>;
  readIdentityProps: (
    device: ParsedDevice,
    transportSerial: string,
    transportId?: string,
  ) => Promise<DeviceIdentity>;
}

const DEFAULT_DEPS: ResolveIdentityDeps = { listDevices, readIdentityProps };

/**
 * Map an endpoint's stable identity onto the transport serial adb accepts *right now*.
 * Never auto-switches to a different identity: zero or multiple matches is a hard error.
 */
export async function resolveIdentity(
  device: ParsedDevice,
  hint?: string,
  deps: ResolveIdentityDeps = DEFAULT_DEPS,
): Promise<IdentityResolution> {
  const all = await deps.listDevices(device);
  const candidates = all.filter((entry) => entry.state === "device");
  if (candidates.length === 0) return { kind: "absent", candidates: all };

  const selector = device.selector;

  if (selector.kind === "identity") {
    // Hint first: one probe in the common single-device case (§4.3 step 2).
    const ordered = hint ? [...candidates].sort((a, b) => (a.serial === hint ? -1 : b.serial === hint ? 1 : 0)) : candidates;
    const probed = await Promise.all(
      ordered.map(async (entry) => {
        try {
          return { entry, identity: (await deps.readIdentityProps(device, entry.serial, entry.transportId)).identity };
        } catch {
          return undefined;
        }
      }),
    );
    const matches = probed.filter((match): match is { entry: DeviceEntry; identity: string } => !!match);
    const hits = matches.filter((match) => match.identity === selector.identity).map((match) => match.entry);
    if (hits.length === 1) return { kind: "resolved", transportSerial: hits[0].serial, entry: hits[0] };
    if (hits.length > 1) return { kind: "collision", matches: hits };
    return { kind: "absent", candidates };
  }

  if (selector.kind === "serial") {
    const hits = candidates.filter((entry) => entry.serial === selector.serial);
    if (hits.length === 1) return { kind: "resolved", transportSerial: hits[0].serial, entry: hits[0] };
    if (hits.length > 1) return { kind: "collision", matches: hits };
    return { kind: "absent", candidates };
  }

  if (selector.kind === "transportId") {
    const hits = candidates.filter((entry) => entry.transportId === selector.transportId);
    if (hits.length === 1) return { kind: "resolved", transportSerial: hits[0].serial, entry: hits[0] };
    if (hits.length > 1) return { kind: "collision", matches: hits };
    return { kind: "absent", candidates };
  }

  if (selector.kind === "pick") {
    const wanted = selector.pick === "usb" ? isUsbSerial : isNetworkSerial;
    const hits = candidates.filter((entry) => wanted(entry.serial));
    if (hits.length === 1) return { kind: "resolved", transportSerial: hits[0].serial, entry: hits[0] };
    if (hits.length === 0) return { kind: "absent", candidates };
    return { kind: "ambiguous", candidates: hits };
  }

  // sole: exactly one device must be attached.
  if (candidates.length === 1) return { kind: "resolved", transportSerial: candidates[0].serial, entry: candidates[0] };
  return { kind: "ambiguous", candidates };
}

function isUsbSerial(serial: string): boolean {
  return !serial.includes(":") && !serial.startsWith("emulator-");
}

function isNetworkSerial(serial: string): boolean {
  return serial.includes(":") || serial.startsWith("emulator-");
}

const CAPABILITY_MARKERS = {
  timeout: "timeout",
  sed: "sed",
  stat: "stat",
  grep: "grep",
  find: "find",
} as const;

/** Batched probe: applet presence, uid, and both shell-protocol checks in one spawn. */
export function capabilitiesCommand(): string {
  const checks = Object.values(CAPABILITY_MARKERS).map(
    (applet) => `echo "@${applet}"; command -v ${applet}`,
  );
  return [
    ...checks,
    'echo "@uid"; id -u',
    'echo "@stderr" 1>&2',
    "echo @exitProbe",
    "exit 7",
  ].join("; ");
}

export function parseCapabilities(
  result: Pick<AdbProcessResult, "stdout" | "stderr" | "exitCode">,
): DeviceCapabilities {
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  const values = parseIdentityProps(stdout);
  const present = (applet: string) => !!values[applet]?.startsWith("/");
  // shell protocol v2 keeps streams apart and forwards the exit code; v1 merges both.
  const stderrSeparation = stderr.includes("@stderr") && !stdout.includes("@stderr");
  const exitCodes = result.exitCode === 7;
  return {
    shellV2: exitCodes && stderrSeparation,
    exitCodes,
    stderrSeparation,
    hasTimeout: present(CAPABILITY_MARKERS.timeout),
    hasSed: present(CAPABILITY_MARKERS.sed),
    hasStat: present(CAPABILITY_MARKERS.stat),
    hasGrep: present(CAPABILITY_MARKERS.grep),
    hasFind: present(CAPABILITY_MARKERS.find),
    uid: values.uid ?? "",
  };
}

/**
 * One batched spawn normally; if the batch is inconclusive (shell protocol v1 merges streams
 * and loses exit codes) fall back to the two individual protocol probes.
 */
export async function probeCapabilities(
  device: ParsedDevice,
  transportSerial: string,
): Promise<DeviceCapabilities> {
  const result = await runAdb(
    shellArgv(device, transportSerial, capabilitiesCommand(), { stdin: false }),
    { timeoutSeconds: SERVER_START_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
  );
  // The batch exits 7 on purpose; anything else that looks like an adb failure is real.
  if (result.exitCode === null || classifyIsFatal(result)) fail(result, "capability probe failed");
  const capabilities = parseCapabilities(result);
  if (capabilities.shellV2) return capabilities;

  const exitProbe = await runAdb(shellArgv(device, transportSerial, "exit 7", { stdin: false }), {
    timeoutSeconds: SERVER_START_SECONDS,
    maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES,
  });
  const stderrProbe = await runAdb(
    shellArgv(device, transportSerial, "echo to-stdout; echo to-stderr 1>&2", { stdin: false }),
    { timeoutSeconds: SERVER_START_SECONDS, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES },
  );
  return {
    ...capabilities,
    exitCodes: exitProbe.exitCode === 7,
    stderrSeparation: stderrProbe.stderr.includes("to-stderr") && !stderrProbe.stdout.includes("to-stderr"),
    shellV2: false,
  };
}

function classifyIsFatal(result: AdbProcessResult): boolean {
  const failure = classifyAdbError(result.stderr.toString("utf8"));
  return failure !== "other";
}

export function classifyAdbError(text: string): AdbFailure {
  const haystack = text.toLowerCase();
  if (/cannot bind listener/.test(haystack)) return "forward-bind-conflict";
  if (/cannot rebind existing socket/.test(haystack)) return "forward-rebind";
  // V24: a busy local port is reported as `failed to reserve port: address already in use`. That
  // is a port conflict owned by another process, not a broken server (F27).
  if (/failed to reserve port|address already in use/.test(haystack)) return "forward-bind-conflict";
  if (/device offline|is offline/.test(haystack)) return "offline";
  if (/unauthorized/.test(haystack)) return "unauthorized";
  if (/more than one device|multiple devices|ambiguous.*device/.test(haystack)) return "ambiguous";
  // V27: `adb: device 'BOGUS' not found`. A bare `not found` is a *device-side* message
  // (V1/V7: `sh: bash: inaccessible or not found`), so it must not mean "device absent".
  if (/device\s+'[^']*'\s+not found|no devices\/emulators|device not found/.test(haystack)) return "absent";
  if (
    /server version|doesn't match this client|protocol fault|cannot connect to daemon|connection reset by peer/.test(
      haystack,
    )
  ) {
    return "server-down";
  }
  return "other";
}

export function recoveryHint(failure: AdbFailure, device: ParsedDevice): string {
  const target = device.command;
  switch (failure) {
    case "absent":
      return `No device matches "${target}" right now. Check the cable or USB debugging authorization, then run /adb devices to see what adb can see.`;
    case "offline":
      return `The device for "${target}" is offline. Unplug/replug or re-authorize wireless debugging, then /adb reconnect.`;
    case "unauthorized":
      return `Accept the "Allow USB debugging" dialog on the phone, then retry.`;
    case "ambiguous":
      return `More than one device is attached. Select one explicitly: /adb adb -s <serial> or /adb adb -i <ro.serialno>.`;
    case "identity-collision":
      return `Two transports report the same ro.serialno. Disconnect one, or select by transport id: /adb adb -t <transport_id>.`;
    case "server-down":
      return `The adb server is unreachable or a different adb version owns it. Align platform-tools or set $ADB; this extension never runs "adb kill-server".`;
    case "forward-bind-conflict":
      return `Another tool already owns that local port. Choose a different local port (adb forward lists the current table).`;
    case "forward-rebind":
      return `That forward is already registered by another adb client; pick a different local port.`;
    case "other":
      // Unclassified adb failure: the diagnosis is the message, so the hint is the next probe.
      return `adb did not classify this failure. Check adb(action="devices") and retry a read-only command before touching the device again.`;
  }
}

/** Bounded `adb wait-for-device`; only explicit reconnects reach it (plan §4.2, Recovering). */
export const WAIT_FOR_DEVICE_SECONDS = 30;
/** The blocked adb client needs no long grace: the budget above is the wait (plan §6 step 11). */
const WAIT_FOR_DEVICE_GRACE_SECONDS = 1;

export async function waitForDevice(
  device: ParsedDevice,
  transportSerial: string | undefined,
  timeoutSeconds = WAIT_FOR_DEVICE_SECONDS,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runAdb(subcommandArgv(device, transportSerial, ["wait-for-device"]), {
    timeoutSeconds,
    maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES,
    graceSeconds: WAIT_FOR_DEVICE_GRACE_SECONDS,
    signal,
  });
  if (result.timedOut) {
    throw new AdbCommandError(
      `Timed out after ${timeoutSeconds}s waiting for ${transportSerial ?? device.command} to come back.`,
      "absent",
      null,
      "",
    );
  }
  if (result.exitCode !== 0) fail(result, "adb wait-for-device failed");
}

/** Idempotent `adb start-server` (V26); refuses to proceed on a client/server version mismatch. */
export async function ensureServer(device: ParsedDevice): Promise<void> {
  const result = await runAdb([...globalArgs(device), "start-server"], {
    timeoutSeconds: SERVER_START_SECONDS,
    maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES,
  });
  // Classify the raw stream first: the mismatch banner is the evidence (F18).
  const raw = result.stderr.toString("utf8");
  const failure = classifyAdbError(raw);
  const stderr = stripAdbBanner(raw);
  if (failure === "server-down") {
    throw new AdbCommandError(
      `adb server mismatch: ${stderr.trim()} — another adb version is running; align platform-tools or set $ADB.`,
      "server-down",
      result.exitCode,
      stderr,
    );
  }
  if (result.exitCode !== 0) fail(result, "adb start-server failed");
}
