/**
 * ADB endpoint grammar: the text a user types (`/adb adb -i 05WAY1YE00`) becomes a
 * `ParsedDevice`, whose canonical `command` is the stable config key.
 *
 * Identity model (plan §4.3): `ro.serialno` is stable, the transport serial is not, and
 * `adb -s` rejects `ro.serialno` for mDNS/TLS transports — so an identity endpoint can only
 * be used after `resolveIdentity` supplies a transport serial.
 */

import { quote, shellWords } from "../shell.ts";

export interface ParsedDevice {
  selector:
    | { kind: "identity"; identity: string }
    | { kind: "serial"; serial: string }
    | { kind: "transportId"; transportId: string }
    | { kind: "pick"; pick: "usb" | "tcp" }
    | { kind: "sole" };
  serverHost?: string;
  serverPort?: number;
  wirelessTarget?: { host: string; port: number };
  /** Canonical config key, produced by `canonicalCommand`. */
  command: string;
  /** Provisional label; replaced at connect with the model/serial label. */
  label: string;
}

const SUPPORTED_GRAMMAR =
  "adb | adb shell | <serial|host:port> | adb -s <serial> [shell] | adb -t <transport_id> | adb -d | adb -e | adb -i <ro.serialno> | adb -H <host> -P <port> [-s <serial>] | adb connect <host>[:port]";

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SERIAL_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/;
const TRANSPORT_ID_PATTERN = /^\d{1,9}$/;
const HOST_PATTERN = /^[A-Za-z0-9._[%):-]{1,255}$/;

function grammarError(detail: string): never {
  throw new Error(`Unsupported adb command: ${detail}. Supported forms: ${SUPPORTED_GRAMMAR}.`);
}

function validatePort(value: number, context: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    grammarError(`invalid ${context} port ${value} (expected 1-65535)`);
  }
  return value;
}

export function parseWirelessTarget(value: string): { host: string; port: number } {
  const split = value.lastIndexOf(":");
  if (split > 0 && /^\d{1,5}$/.test(value.slice(split + 1))) {
    const host = value.slice(0, split);
    if (!HOST_PATTERN.test(host)) grammarError(`invalid host ${quote(host)}`);
    return { host, port: validatePort(Number(value.slice(split + 1)), "wireless") };
  }
  if (!HOST_PATTERN.test(value)) grammarError(`invalid host ${quote(value)}`);
  return { host: value, port: 5555 };
}

export interface CanonicalInput {
  serverHost?: string;
  serverPort?: number;
  identity?: string;
  serial?: string;
  transportId?: string;
  pick?: "usb" | "tcp";
  sole?: boolean;
  wireless?: { host: string; port: number };
}

/** The persisted endpoint key. Stable for a given endpoint across resolution. */
export function canonicalCommand(input: CanonicalInput): string {
  const parts = ["adb"];
  if (input.serverHost) parts.push("-H", input.serverHost, "-P", String(input.serverPort ?? 5037));
  // Global options precede the subcommand, as adb expects them; the connect target *is* the selector.
  if (input.wireless) return [...parts, "connect", `${input.wireless.host}:${input.wireless.port}`].join(" ");
  if (input.identity) parts.push("-i", input.identity);
  else if (input.serial) parts.push("-s", input.serial);
  else if (input.transportId) parts.push("-t", input.transportId);
  else if (input.pick === "usb") parts.push("-d");
  else if (input.pick === "tcp") parts.push("-e");
  return parts.join(" ");
}

export function endpointKey(device: ParsedDevice): string {
  return device.command;
}

function labelFor(device: ParsedDevice): string {
  if (device.wirelessTarget) return `${device.wirelessTarget.host}:${device.wirelessTarget.port}`;
  const selector = device.selector;
  switch (selector.kind) {
    case "identity":
      return `device ${selector.identity}`;
    case "serial":
      return selector.serial;
    case "transportId":
      return `transport ${selector.transportId}`;
    case "pick":
      return selector.pick === "usb" ? "USB device" : "emulator";
    case "sole":
      return "default device";
  }
}

function build(device: Omit<ParsedDevice, "command" | "label">): ParsedDevice {
  const selector = device.selector;
  const withCommand: ParsedDevice = {
    selector,
    ...(device.serverHost === undefined ? {} : { serverHost: device.serverHost }),
    ...(device.serverPort === undefined ? {} : { serverPort: device.serverPort }),
    ...(device.wirelessTarget === undefined ? {} : { wirelessTarget: device.wirelessTarget }),
    command: canonicalCommand({
      serverHost: device.serverHost,
      serverPort: device.serverPort,
      wireless: device.wirelessTarget,
      identity: selector.kind === "identity" ? selector.identity : undefined,
      serial: selector.kind === "serial" ? selector.serial : undefined,
      transportId: selector.kind === "transportId" ? selector.transportId : undefined,
      pick: selector.kind === "pick" ? selector.pick : undefined,
      sole: selector.kind === "sole",
    }),
    label: "",
  };
  withCommand.label = labelFor(withCommand);
  return withCommand;
}

/** Serial-shaped positional argument (`05WAY1YE00`, `192.168.1.5:5555`, mDNS serial). */
function serialSelector(token: string) {
  if (!SERIAL_PATTERN.test(token) || token.startsWith("-")) grammarError(`invalid serial ${quote(token)}`);
  return { kind: "serial" as const, serial: token };
}

export function parseAdbCommand(input: string): ParsedDevice {
  let words: string[];
  try {
    words = shellWords(input);
  } catch {
    return grammarError("incomplete quoting or escaping");
  }
  if (words.length === 0) return grammarError("empty command");

  // Bare positional form: `<serial>` or `<host:port>` with no `adb` prefix.
  if (words[0] !== "adb") {
    if (words.length > 1) grammarError("two positionals are not supported");
    return build({ selector: serialSelector(words[0]) });
  }
  if (words.length === 1) return build({ selector: { kind: "sole" } });

  let serverHost: string | undefined;
  let serverPort: number | undefined;
  let wirelessTarget: { host: string; port: number } | undefined;
  const selectors: ParsedDevice["selector"][] = [];
  let positionals = 0;
  let shellSeen = false;

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const next = (missing: string): string => {
      const value = words[++i];
      if (value === undefined || value.startsWith("-")) grammarError(missing);
      return value;
    };
    switch (word) {
      case "connect":
      case "pair": {
        if (wirelessTarget) grammarError(`adb ${word} may only appear once`);
        const target = parseWirelessTarget(next(`${word} requires <host>[:port]`));
        if (word === "pair") grammarError("adb pair is a one-shot pairing helper and cannot be used as an endpoint");
        wirelessTarget = target;
        break;
      }
      case "-d":
        selectors.push({ kind: "pick", pick: "usb" });
        break;
      case "-e":
        selectors.push({ kind: "pick", pick: "tcp" });
        break;
      case "-s":
        selectors.push(serialSelector(next("-s requires a serial")));
        break;
      case "-t": {
        const transportId = next("-t requires a transport id");
        if (!TRANSPORT_ID_PATTERN.test(transportId)) grammarError(`invalid transport id ${quote(transportId)}`);
        selectors.push({ kind: "transportId", transportId });
        break;
      }
      // `-i` is ours (identity), not adb's: adb uses -i for something else entirely.
      case "-i": {
        const identity = next("-i requires a ro.serialno");
        if (!IDENTITY_PATTERN.test(identity)) grammarError(`invalid identity ${quote(identity)}`);
        selectors.push({ kind: "identity", identity });
        break;
      }
      case "-H": {
        const host = next("-H requires a host");
        if (!HOST_PATTERN.test(host) || host.includes("/")) grammarError(`invalid server host ${quote(host)}`);
        serverHost = host;
        break;
      }
      case "-P":
        serverPort = validatePort(Number(next("-P requires a port")), "server");
        break;
      case "shell":
        shellSeen = true;
        break;
      default:
        if (word.startsWith("-")) grammarError(`unknown flag ${word}`);
        if (shellSeen) grammarError("`shell` cannot be combined with a positional serial");
        positionals++;
        if (positionals > 1) grammarError("two positionals are not supported");
        selectors.push(serialSelector(word));
    }
  }

  if (shellSeen && positionals > 0) grammarError("`shell` cannot be combined with a positional serial");
  if (serverPort !== undefined && !serverHost) grammarError("-P requires -H");
  // The server port is part of the canonical key: normalize its default at parse time.
  if (serverHost && serverPort === undefined) serverPort = 5037;
  if (selectors.length > 1) grammarError("only one of -s, -t, -d, -e, -i may be used");
  if (wirelessTarget) {
    if (selectors.length > 0) grammarError("adb connect cannot be combined with a device selector");
    return build({
      wirelessTarget,
      serverHost,
      serverPort,
      selector: { kind: "serial", serial: `${wirelessTarget.host}:${wirelessTarget.port}` },
    });
  }

  const selector = selectors[0] ?? { kind: "sole" as const };
  return build({ selector, serverHost, serverPort });
}

/**
 * Global adb arguments. `transportSerial` is the resolved value from `adb devices -l`;
 * an unresolved identity endpoint must never reach adb (V28).
 */
export function deviceArgs(device: ParsedDevice, transportSerial?: string): string[] {
  const args: string[] = [];
  if (device.serverHost) {
    args.push("-H", device.serverHost, "-P", String(device.serverPort ?? 5037));
  }
  if (transportSerial) {
    args.push("-s", transportSerial);
    return args;
  }
  switch (device.selector.kind) {
    case "serial":
      args.push("-s", device.selector.serial);
      break;
    case "transportId":
      args.push("-t", device.selector.transportId);
      break;
    case "pick":
      args.push(device.selector.pick === "usb" ? "-d" : "-e");
      break;
    case "identity":
      throw new Error(
        `adb cannot select a device by ro.serialno (${device.selector.identity}); resolve it to a transport serial first`,
      );
    case "sole":
      break;
  }
  return args;
}
