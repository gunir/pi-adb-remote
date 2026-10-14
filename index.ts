/**
 * Pi ADB Remote extension.
 *
 * Gives Pi a persistent Android device workspace by routing file and shell tools
 * onto the device through short-lived `adb` subprocesses. It manages endpoint
 * configuration, device identity and capabilities, the device working directory,
 * reconnection, `adb forward` port mappings, and the PC<->device bridge actions
 * (screen capture, pull, push, install, uninstall).
 *
 * There is no long-lived connection: "connected" is a belief that is refreshed by
 * probing `adb devices`/`get-state`, and every device interaction is one bounded
 * subprocess. The device has no `bash`, so commands run under POSIX `sh`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  SettingsManager,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
  keyHint,
  truncateHead,
  truncateTail,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { quote } from "./src/shell.ts";
import { runAdb, subcommandArgv } from "./src/adb/cli.ts";
import {
  classifyAdbError,
  ensureServer,
  getState,
  listDevices,
  probeCapabilities,
  readIdentityProps,
  recoveryHint,
  resolveIdentity,
  waitForDevice,
  CONTROL_MAX_CAPTURE_BYTES,
  WAIT_FOR_DEVICE_SECONDS,
  type AdbFailure,
  type DeviceCapabilities,
  type DeviceIdentity,
  type DeviceState as AdbDeviceState,
} from "./src/adb/device.ts";
import {
  DEFAULT_DEVICE_TIMEOUT_SECONDS,
  DEFAULT_INSTALL_TIMEOUT_SECONDS,
  AdbTransport,
  DeviceCommandError,
  InstallFailure,
  METHOD_CLASS,
  parseForwardSpec,
  serializeForwardSpec,
  type DeviceForwardSpec,
} from "./src/adb/transport.ts";
import {
  extensionMime,
  isImageMime,
  isTextMimeType,
  looksLikeText,
  sniffFileKind,
} from "./src/adb/mime.ts";
import {
  OUTPUT_FOOTER_RESERVE_BYTES,
  SPILL_CAP_BYTES,
  createOutputFile,
  createSessionOutputDir,
  previewDeviceOutput,
  saveOutput,
  DeviceExecAccumulator,
} from "./src/adb/exec-output.ts";
import { endpointKey, parseAdbCommand, type ParsedDevice } from "./src/adb/target.ts";

interface DeviceRuntime {
  device: ParsedDevice;
  identity: string;
  transportSerial: string;
  transport: AdbTransport;
  capabilities: DeviceCapabilities;
  identityInfo: DeviceIdentity;
  cwd: string;
  /** Set when the configured cwd was missing at connect time; cleared on the next resolve. */
  unavailableCwd?: string;
  lastSuccessAt: number;
  lastProbeAt: number;
}

interface RuntimeCache {
  resume?: { identity: string; command: string; cwd: string; routeDeviceTools: boolean; forwards?: string[] };
}

interface DeviceEndpointConfig {
  adbCommand?: string;
  deviceCwd?: string;
  forwards?: string[];
  note?: string;
  imageMaxBytes?: number;
}

interface DeviceMemoryEntry {
  id: string;
  content: string;
}

interface DeviceMemoryFile {
  device: string;
  entries: DeviceMemoryEntry[];
}

interface DeviceConfig {
  activeEndpoint?: string;
  endpoints?: Record<string, DeviceEndpointConfig>;
  displayLines?: number;
  readMaxLines?: number;
  readMaxBytes?: number;
  execMaxLines?: number;
  execMaxBytes?: number;
  turnMaxBytes?: number;
}

interface SessionDeviceState {
  version: 2;
  connected: boolean;
  /** Stable device identity (`ro.serialno`); the transport serial is never persisted. */
  identity?: string;
  /** Endpoint selector command, kept so a named endpoint can be rebuilt after a reload. */
  command?: string;
  cwd?: string;
  routeDeviceTools?: boolean;
  forwards?: string[];
}

// Use Pi's agent dir so Windows follows USERPROFILE and PI_CODING_AGENT_DIR is honored.
const AGENT_DIR = getAgentDir();
const ADB_CONFIG_FILE = join(AGENT_DIR, "adb-remote-config.json");
const DEVICE_MEMORY_DIR = join(AGENT_DIR, "adb-remote-memories");
/** The one world-writable, exec-bit-preserving directory on every Android release (V15/V16). */
const DEFAULT_DEVICE_CWD = "/data/local/tmp";
const DEFAULT_DISPLAY_LINES = 5;
const MAX_DISPLAY_LINES = 50;
const DEFAULT_READ_MAX_LINES = 400;
const DEFAULT_READ_MAX_BYTES = 16 * 1024;
const DEFAULT_EXEC_MAX_LINES = 200;
const DEFAULT_EXEC_MAX_BYTES = 8 * 1024;
const DEFAULT_TURN_MAX_BYTES = 32 * 1024;
const MIN_MODEL_OUTPUT_BYTES = 1024;
const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEVICE_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
/** Belief freshness window: older than this, the next op probes the device first. */
const STALE_DEVICE_STATE_MS = 15_000;
const TRANSIENT_STATE_POLL_MS = 500;
const TRANSIENT_STATE_MAX_MS = 5_000;
const SNIFF_SAMPLE_BYTES = 8192;
const SESSION_STATE_ENTRY_TYPE = "pi-adb-remote-state";
const RUNTIME_CACHE_KEY = "__piAdbRemoteRuntimeV1";
const DEVICE_FILE_TOOL_ROUTING_DESCRIPTION = "With device routing active, this tool operates directly on the device workspace.";
const DEVICE_SHELL_TOOL_ROUTING_DESCRIPTION = "With device routing active, this tool runs directly in the device workspace.";
const cacheHost = globalThis as typeof globalThis & { [RUNTIME_CACHE_KEY]?: RuntimeCache };
const runtimeCache = cacheHost[RUNTIME_CACHE_KEY] ??= {};

function deviceMemoryId(identity: string): string {
  return identity;
}

function parseBoundedInteger(value: unknown, label: string, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseDisplayLines(value: unknown): number {
  return parseBoundedInteger(value, "Display lines", MAX_DISPLAY_LINES);
}

function parseOutputLines(value: unknown, label: string): number {
  return parseBoundedInteger(value, label, DEFAULT_MAX_LINES);
}

function parseOutputBytes(value: unknown, label: string, maximum = DEFAULT_MAX_BYTES): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_MODEL_OUTPUT_BYTES || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${MIN_MODEL_OUTPUT_BYTES} to ${maximum}`);
  }
  return parsed;
}

function parseImageMaxBytes(value: unknown): number {
  return parseBoundedInteger(value, "Image max bytes", MAX_IMAGE_MAX_BYTES);
}

function parseDeviceTimeout(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DEVICE_TIMEOUT_SECONDS) {
    throw new Error(`Timeout must be a positive number no greater than ${MAX_DEVICE_TIMEOUT_SECONDS} seconds`);
  }
  return seconds;
}

function configuredDisplayLines(config = loadDeviceConfig()): number {
  try { return parseDisplayLines(config.displayLines ?? DEFAULT_DISPLAY_LINES); }
  catch { return DEFAULT_DISPLAY_LINES; }
}

function configuredOutputLimits(config = loadDeviceConfig()) {
  const readMaxLines = (() => { try { return parseOutputLines(config.readMaxLines ?? DEFAULT_READ_MAX_LINES, "Read max lines"); } catch { return DEFAULT_READ_MAX_LINES; } })();
  const readMaxBytes = (() => { try { return parseOutputBytes(config.readMaxBytes ?? DEFAULT_READ_MAX_BYTES, "Read max bytes"); } catch { return DEFAULT_READ_MAX_BYTES; } })();
  const execMaxLines = (() => { try { return parseOutputLines(config.execMaxLines ?? DEFAULT_EXEC_MAX_LINES, "Exec max lines"); } catch { return DEFAULT_EXEC_MAX_LINES; } })();
  const execMaxBytes = (() => { try { return parseOutputBytes(config.execMaxBytes ?? DEFAULT_EXEC_MAX_BYTES, "Exec max bytes"); } catch { return DEFAULT_EXEC_MAX_BYTES; } })();
  const turnMaxBytes = (() => { try { return parseOutputBytes(config.turnMaxBytes ?? DEFAULT_TURN_MAX_BYTES, "Turn max bytes", DEFAULT_MAX_BYTES * 4); } catch { return DEFAULT_TURN_MAX_BYTES; } })();
  return { readMaxLines, readMaxBytes, execMaxLines, execMaxBytes, turnMaxBytes };
}

function commandFromEndpointKey(key: string): string | undefined {
  // Endpoint keys are the canonical adb command; anything else is a legacy or hand-edited row.
  const trimmed = key.trim();
  return /^adb(\s|$)/.test(trimmed) ? trimmed : undefined;
}

function normalizeDeviceConfig(config: DeviceConfig): DeviceConfig {
  const endpoints = { ...(config.endpoints ?? {}) };
  const endpointEntries = Object.entries(endpoints).sort(([left], [right]) =>
    left === config.activeEndpoint ? -1 : right === config.activeEndpoint ? 1 : 0,
  );
  for (const [key, endpoint] of endpointEntries) {
    const command = endpoint.adbCommand || commandFromEndpointKey(key);
    endpoints[key] = {
      forwards: endpoint.forwards,
      note: endpoint.note,
      deviceCwd: endpoint.deviceCwd,
      imageMaxBytes: endpoint.imageMaxBytes,
      ...(command ? { adbCommand: command } : {}),
    };
    for (const [field, value] of Object.entries(endpoints[key]!)) if (value === undefined) delete (endpoints[key] as Record<string, unknown>)[field];
  }

  let activeEndpoint = config.activeEndpoint;
  if (activeEndpoint && !endpoints[activeEndpoint]) activeEndpoint = undefined;
  activeEndpoint ??= Object.keys(endpoints)[0];

  return {
    ...(activeEndpoint ? { activeEndpoint } : {}),
    ...(Object.keys(endpoints).length ? { endpoints } : {}),
    ...(config.displayLines !== undefined ? { displayLines: config.displayLines } : {}),
    ...(config.readMaxLines !== undefined ? { readMaxLines: config.readMaxLines } : {}),
    ...(config.readMaxBytes !== undefined ? { readMaxBytes: config.readMaxBytes } : {}),
    ...(config.execMaxLines !== undefined ? { execMaxLines: config.execMaxLines } : {}),
    ...(config.execMaxBytes !== undefined ? { execMaxBytes: config.execMaxBytes } : {}),
    ...(config.turnMaxBytes !== undefined ? { turnMaxBytes: config.turnMaxBytes } : {}),
  };
}

function loadDeviceConfig(): DeviceConfig {
  try { return normalizeDeviceConfig(JSON.parse(readFileSync(ADB_CONFIG_FILE, "utf8"))); }
  catch { return {}; }
}

function saveDeviceConfig(config: DeviceConfig): void {
  mkdirSync(dirname(ADB_CONFIG_FILE), { recursive: true });
  writeFileSync(ADB_CONFIG_FILE, JSON.stringify(normalizeDeviceConfig(config), null, 2) + "\n", { mode: 0o600 });
}

function endpointKeyValue(device: ParsedDevice): string {
  return endpointKey(device);
}

function endpointConfig(config: DeviceConfig, command: string): DeviceEndpointConfig {
  try { return config.endpoints?.[endpointKeyValue(parseAdbCommand(command))] ?? {}; }
  catch { return {}; }
}

function activeEndpointConfig(config: DeviceConfig): DeviceEndpointConfig | undefined {
  return config.activeEndpoint ? config.endpoints?.[config.activeEndpoint] : undefined;
}

function activeAdbCommand(config = loadDeviceConfig()): string | undefined {
  return activeEndpointConfig(config)?.adbCommand;
}

function saveEndpointConfig(command: string, updates: DeviceEndpointConfig, makeActive = false): void {
  const config = loadDeviceConfig();
  const key = endpointKeyValue(parseAdbCommand(command));
  saveDeviceConfig({
    ...config,
    ...(makeActive ? { activeEndpoint: key } : {}),
    endpoints: {
      ...(config.endpoints ?? {}),
      [key]: { ...endpointConfig(config, command), adbCommand: command, ...updates },
    },
  });
}

const ADB_TOP_LEVEL_COMPLETIONS: AutocompleteItem[] = [
  { value: "devices", label: "devices", description: "List attached devices and their transport serials" },
  { value: "connect", label: "connect", description: "Connect to a device by adb command" },
  { value: "config", label: "config", description: "Show or change device configuration" },
  { value: "use", label: "use", description: "Select a saved endpoint" },
  { value: "memory", label: "memory", description: "Show memory for the selected device" },
  { value: "forward", label: "forward", description: "Start adb port forwarding" },
  { value: "unforward", label: "unforward", description: "Stop extension-managed port forwards" },
  { value: "exec", label: "exec", description: "Run a command in the device cwd" },
  { value: "cd", label: "cd", description: "Change the device working directory" },
  { value: "screen", label: "screen", description: "Capture the device screen as a PNG" },
  { value: "pull", label: "pull", description: "Copy a device file to the PC" },
  { value: "push", label: "push", description: "Copy a PC file to the device" },
  { value: "install", label: "install", description: "Install an APK from the PC" },
  { value: "uninstall", label: "uninstall", description: "Remove a package from the device" },
  { value: "pair", label: "pair", description: "Pair with a wireless debugging device" },
  { value: "status", label: "status", description: "Show the active device workspace" },
  { value: "reconnect", label: "reconnect", description: "Re-probe and reconnect the active device" },
  { value: "disconnect", label: "disconnect", description: "Disconnect and return tools to local execution" },
];

const ADB_CONFIG_COMPLETIONS: AutocompleteItem[] = [
  { value: "note", label: "note", description: "Set or clear the endpoint note" },
  { value: "cwd", label: "cwd", description: "Set the default device working directory" },
  { value: "forward", label: "forward", description: "Persist port-forward mappings" },
  { value: "display-lines", label: "display-lines", description: "Set collapsed command preview lines" },
  { value: "read-max-lines", label: "read-max-lines", description: "Set device read line budget" },
  { value: "read-max-bytes", label: "read-max-bytes", description: "Set device read byte budget" },
  { value: "exec-max-lines", label: "exec-max-lines", description: "Set command output line budget" },
  { value: "exec-max-bytes", label: "exec-max-bytes", description: "Set command output byte budget" },
  { value: "turn-max-bytes", label: "turn-max-bytes", description: "Set aggregate per-turn output budget" },
  { value: "image-max-bytes", label: "image-max-bytes", description: "Set the largest image the read tool will accept" },
];

const ADB_EXEC_COMPLETIONS: AutocompleteItem[] = [
  { value: "--timeout", label: "--timeout", description: "Override command timeout in seconds" },
  { value: "--lines", label: "--lines", description: "Override collapsed preview line count" },
];

function filterAutocompleteItems(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  const needle = prefix.toLowerCase();
  // Pi consumes Enter while an argument completion is active. A complete token
  // must submit as-is, even if it is also a prefix of another saved endpoint.
  if (items.some((item) => item.value.toLowerCase() === needle)) return null;
  const matches = items.filter((item) => item.value.toLowerCase().startsWith(needle));
  return matches.length ? matches : null;
}

function withCompletionPrefix(items: AutocompleteItem[], commandPrefix: string): AutocompleteItem[] {
  return items.map((item) => ({ ...item, value: `${commandPrefix}${item.label ?? item.value}` }));
}

function completionTokenPrefix(input: string): { prefix: string; currentToken: string } {
  const match = input.match(/^(.*\s)(\S*)$/s);
  if (!match) return { prefix: "", currentToken: input };
  return { prefix: match[1] ?? "", currentToken: match[2] ?? "" };
}

function getDeviceArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const input = prefix.replace(/^\/?adb(?:\s+|$)/i, "");
  if (!input.includes(" ")) {
    return filterAutocompleteItems(ADB_TOP_LEVEL_COMPLETIONS, input);
  }

  const useMatch = input.match(/^use\s+(.*)$/i);
  if (useMatch) {
    const config = loadDeviceConfig();
    const endpoints: AutocompleteItem[] = Object.keys(config.endpoints ?? {}).map((key) => ({
      value: key,
      label: key,
      description: key === config.activeEndpoint ? "Active endpoint" : "Saved endpoint",
    }));
    const matches = filterAutocompleteItems(endpoints, useMatch[1] ?? "");
    return matches ? withCompletionPrefix(matches, "use ") : null;
  }

  const configMatch = input.match(/^config\s+(.*)$/i);
  if (configMatch) {
    const remainder = configMatch[1] ?? "";
    if (!remainder.includes(" ")) {
      const matches = filterAutocompleteItems(ADB_CONFIG_COMPLETIONS, remainder);
      return matches ? withCompletionPrefix(matches, "config ") : null;
    }
    const noteMatch = remainder.match(/^note\s+(.*)$/i);
    if (noteMatch) {
      const matches = filterAutocompleteItems([{ value: "--clear", label: "--clear", description: "Clear the endpoint note" }], noteMatch[1] ?? "");
      return matches ? withCompletionPrefix(matches, "config note ") : null;
    }
    return null;
  }

  const execMatch = input.match(/^exec\s+(.*)$/i);
  if (execMatch) {
    const remainder = execMatch[1] ?? "";
    if (!remainder || remainder.startsWith("--")) {
      const { prefix: execPrefix, currentToken } = completionTokenPrefix(remainder);
      const matches = filterAutocompleteItems(ADB_EXEC_COMPLETIONS, currentToken);
      return matches ? withCompletionPrefix(matches, `exec ${execPrefix}`) : null;
    }
    return null;
  }

  return null;
}

function suppressDeviceCompletionsBeforeSuffix(current: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const commandStart = /^\s*\/adb(?=\s|$)/i.exec(line);
      const afterCursor = line.slice(cursorCol);
      if (commandStart && cursorCol >= commandStart[0].length && /\S/.test(afterCursor)) return null;
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
  };
}

function deviceMemoryFilePath(identity: string): string {
  return join(DEVICE_MEMORY_DIR, `${Buffer.from(deviceMemoryId(identity), "utf8").toString("base64url")}.json`);
}

function writeDeviceMemoryFile(path: string, memory: DeviceMemoryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(memory, null, 2) + "\n", { mode: 0o600 });
}

function ensureDeviceMemoryFile(identity: string): string {
  const path = deviceMemoryFilePath(identity);
  if (!existsSync(path)) writeDeviceMemoryFile(path, { device: deviceMemoryId(identity), entries: [] });
  return path;
}

function loadDeviceMemory(identity: string): DeviceMemoryFile | undefined {
  const path = deviceMemoryFilePath(identity);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeviceMemoryFile>;
  if (parsed.device !== deviceMemoryId(identity) || !Array.isArray(parsed.entries)) {
    throw new Error("expected an object with the matching device and an entries array");
  }
  const ids = new Set<string>();
  const entries = parsed.entries.map((entry, index) => {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.content !== "string" || !entry.content.trim()) {
      throw new Error(`entry ${index + 1} must contain non-empty string id and content fields`);
    }
    const id = entry.id.trim();
    if (ids.has(id)) throw new Error(`duplicate entry id: ${id}`);
    ids.add(id);
    return { id, content: entry.content.trim() };
  });
  return { device: parsed.device, entries };
}

function formatDeviceMemoryEntries(memory: DeviceMemoryFile | undefined): string {
  if (!memory?.entries.length) return "No entries.";
  return memory.entries.map((entry) => `[${entry.id}]\n${entry.content}`).join("\n\n");
}

function memoryManagementPrompt(state: DeviceRuntime): string {
  let path = deviceMemoryFilePath(state.identity);
  try { path = ensureDeviceMemoryFile(state.identity); }
  catch {}
  return `Persistent memory for this device is a local JSON file at ${path}. This exact path is always handled by Pi's local read, write, and edit tools even while other tools are routed to the device. The file schema is {"device":"${deviceMemoryId(state.identity)}","entries":[{"id":"stable-unique-id","content":"memory text"}]}. If the file does not exist, create it with that device value and an empty entries array. Read the file before changing it and preserve valid JSON plus all unrelated entries. Add by appending one object with a unique stable id; query by reading the file; update by editing only the matching id. DELETE SAFETY: delete an entry only when the user explicitly asks to delete, remove, or forget device memory. Before deleting, read the file and identify the exact id; if the target is ambiguous, ask the user. Use edit to remove only that exact object and preserve every other entry. Never treat a correction or replacement request as permission to delete, and never delete all entries unless the user explicitly requests deletion of all device memory.`;
}

function deviceWorkspacePrompt(state: DeviceRuntime): string {
  return `You are working ON an Android device (${deviceDisplayLabel(state, state.cwd)}). Pi's read, write, edit and bash tools already execute inside this device shell: never prefix a command with \`adb shell\`, and never assume a PC filesystem. The device runs POSIX \`sh\` (toybox/mksh) only - there is no bash, no systemd, no curl; \`/system\` is read-only, \`/sdcard\` strips executable bits, and \`${DEFAULT_DEVICE_CWD}\` is the writable workspace. Phone output can be enormous: bound it (\`logcat -d -t 200\`, \`dumpsys X | head\`, \`tail -n 200\`) and use adb(action="pull"/"push") to move files between the device and this PC.`;
}

function deviceMemoryContext(state: DeviceRuntime): string | undefined {
  const path = deviceMemoryFilePath(state.identity);
  let memory: DeviceMemoryFile | undefined;
  try { memory = loadDeviceMemory(state.identity); }
  catch (error) {
    return `<adb_remote_device_memory device="${state.identity}" path="${path}">\nThe device-memory JSON file is invalid and must not be applied until repaired: ${(error as Error).message}\n</adb_remote_device_memory>`;
  }
  if (!memory?.entries.length) return undefined;
  return `<adb_remote_device_memory device="${state.identity}" path="${path}">\nThe following user-configured JSON entries are persistent memory specific to this device. Apply their content while working on it:\n${JSON.stringify(memory.entries, null, 2)}\n</adb_remote_device_memory>`;
}

function endpointNote(command: string): string | undefined {
  return endpointConfig(loadDeviceConfig(), command).note?.trim();
}

/** Pre-connect label: what the user typed, annotated with the saved note. */
function deviceCommandLabel(device: ParsedDevice, cwd?: string): string {
  const note = endpointNote(device.command);
  return `${note ? `${note} (${device.label})` : device.label}${cwd ? `:${cwd}` : ""}`;
}

/** Post-connect label: real device facts, because the selector says nothing about the phone. */
function deviceDisplayLabel(state: DeviceRuntime, cwd?: string): string {
  const note = endpointNote(state.device.command);
  const props = state.identityInfo.props;
  const model = props.model ?? props.product ?? state.identityInfo.identity;
  const label = note ? `${note} (${model})` : model;
  return cwd ? `${label}:${cwd}` : label;
}

/** `get-state` vocabulary mapped onto the failure vocabulary `recoveryHint` understands. */
function stateFailure(state: Exclude<AdbDeviceState, "device">): AdbFailure {
  switch (state) {
    case "offline": return "offline";
    case "unauthorized": case "authorizing": return "unauthorized";
    case "absent": return "absent";
    default: return "other";
  }
}

function capabilitySnapshot(caps: DeviceCapabilities): string {
  return Object.entries(caps).map(([key, value]) => `${key}=${value}`).join(",");
}

function deviceFailureMessage(error: unknown, state: DeviceRuntime | null): string {
  const message = error instanceof Error ? error.message : String(error);
  const failure = classifyAdbError(message);
  const hint = state ? recoveryHint(failure, state.device) : "";
  return hint ? `${message}\n${hint}` : message;
}

function renderAdbControlCall(params: any, theme: any): Component {
  const args = params ?? {};
  const action = typeof args.action === "string" && args.action ? args.action : "...";
  const stringArg = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
  let operand: string | undefined;

  if (action === "exec") {
    operand = `$ ${stringArg(args.deviceCommand) || "..."}`;
  } else if (action === "connect" || action === "pair" || action === "install" || action === "uninstall") {
    operand = stringArg(args.command) ?? stringArg(args.hostPath) ?? stringArg(args.packageName);
  } else if (action === "forward") {
    const forwards = stringArg(args.forwards);
    if (forwards !== undefined) operand = forwards || "...";
  } else if (action === "chdir") {
    operand = stringArg(args.cwd) || "...";
  } else if (action === "note") {
    const note = stringArg(args.note);
    operand = note === undefined || note.trim() === "" ? "clear note" : note.trim();
  } else if (action === "memory") {
    operand = stringArg(args.command);
  } else if (action === "pull" || action === "push" || action === "screen") {
    operand = [stringArg(args.devicePath), stringArg(args.hostPath)].filter(Boolean).join(" <- ");
  }

  const title = theme.fg("toolTitle", theme.bold("adb"));
  const actionText = theme.fg("muted", ` ${action}`);
  const operandText = operand ? theme.fg("accent", `  ${operand}`) : "";
  return new Text(`${title}${actionText}${operandText}`, 0, 0);
}

function renderAdbControlResult(result: any, expanded: boolean, theme: any): Component {
  const fallback = result.content?.find((item: any) => item.type === "text")?.text ?? "";
  const details = result.details;
  if (details?.summary && details.action !== "exec") {
    return {
      render: (width: number) => [truncateToWidth(details.summary, width)],
      invalidate() {}, // Stateless: the summary is rendered afresh at each width.
    };
  }
  if (details?.action !== "exec") return new Text(fallback, 0, 0);

  const output = details.output || fallback;
  const displayLines = details.displayLines || DEFAULT_DISPLAY_LINES;
  const warnings = [
    ...(details.fullOutputPath ? [`Full output: ${details.fullOutputPath}`] : []),
    ...(details.truncation?.truncated ? [`Truncated: showing ${details.truncation.outputLines} of ${details.truncation.totalLines} lines`] : []),
  ];
  const warning = warnings.length ? warnings.join(". ") : undefined;

  if (expanded) {
    return new Text(`${output}${warning ? `\n${theme.fg("warning", `[${warning}]`)}` : ""}`, 0, 0);
  }

  return {
    render(width: number) {
      const styled = output.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
      const visualLines = new Text(styled, 0, 0).render(width);
      const shown = visualLines.slice(-displayLines);
      const skipped = visualLines.length - shown.length;
      const hint = skipped > 0
        ? [theme.fg("muted", `... (${skipped} earlier lines, ${keyHint("app.tools.expand", "to expand")})`)]
        : [];
      return [...hint, ...shown, ...(warning ? [theme.fg("warning", `[${warning}]`)] : [])];
    },
    invalidate() {},
  };
}

class SecretInput implements Component, Focusable {
  focused = false;
  private value = "";
  private label: string;
  private done: (value: string | null) => void;
  private renderNow: () => void;

  constructor(label: string, done: (value: string | null) => void, renderNow: () => void) {
    this.label = label;
    this.done = done;
    this.renderNow = renderNow;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) return this.done(this.value);
    if (matchesKey(data, Key.escape)) return this.done(null);
    if (matchesKey(data, Key.backspace)) this.value = [...this.value].slice(0, -1).join("");
    else if (matchesKey(data, Key.ctrl("u"))) this.value = "";
    else {
      const clean = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
      if ([...clean].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)) this.value += clean;
    }
    this.renderNow();
  }
  render(width: number): string[] {
    return [truncateToWidth(`${this.label}: ${"•".repeat([...this.value].length)}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`, width, "")];
  }
  invalidate(): void {}
}

/** Hidden-input prompt; the pairing code must never appear in argv, config, or transcripts. */
async function askPasscode(ctx: any, label: string, placeholder: string): Promise<string | null> {
  if (ctx.mode !== "tui") return (await ctx.ui.input(`${label}:`, placeholder)) ?? null;
  const value = await ctx.ui.custom((tui: any, _theme: any, _keys: any, done: (value: string | null) => void) =>
    new SecretInput(label, done, () => tui.requestRender()));
  return value as string | null;
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

export default function adbRemoteExtension(pi: ExtensionAPI) {
  mkdirSync(DEVICE_MEMORY_DIR, { recursive: true });

  const localCwd = process.cwd();
  let device: DeviceRuntime | null = null;
  let routeDeviceTools = false;
  let currentCtx: any;
  let reconnectPromise: Promise<DeviceRuntime> | null = null;
  /** In-flight `adb forward` mappings owned by this extension - the definition of "ours". */
  const forwardSpecs = new Map<number, DeviceForwardSpec>();
  let sessionReady = false;
  let restoringSessionState = false;
  let lastConnectionError: string | undefined;
  let lastCommand = runtimeCache.resume?.command ?? activeAdbCommand() ?? "";
  let lastIdentity = runtimeCache.resume?.identity;
  let lastCwd = runtimeCache.resume?.cwd;
  let turnOutputBytes = 0;
  let scratchDir = createSessionOutputDir();
  /** Serializes cwd changes so a chdir can never repoint a command that already started (F26/F27). */
  let cwdQueue: Promise<unknown> = Promise.resolve();

  const configuredCwd = (command: string): string =>
    endpointConfig(loadDeviceConfig(), command).deviceCwd || DEFAULT_DEVICE_CWD;

  const configuredForwards = (command: string): string[] =>
    endpointConfig(loadDeviceConfig(), command).forwards ?? [];

  const configuredImageCap = (command: string): number => {
    try { return parseImageMaxBytes(endpointConfig(loadDeviceConfig(), command).imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES); }
    catch { return DEFAULT_IMAGE_MAX_BYTES; }
  };

  const limits = () => {
    const command = device?.device.command ?? lastCommand;
    return {
      imageMaxBytes: command ? configuredImageCap(command) : DEFAULT_IMAGE_MAX_BYTES,
      spillCapBytes: SPILL_CAP_BYTES,
    };
  };

  const connectionDescription = (): string => {
    const command = device?.device.command ?? lastCommand;
    const state = `ADB device: ${device ? "connected" : "disconnected"}; tool routing: ${routeDeviceTools ? "device" : "local"}.`;
    if (!command) return state;
    const cwd = device?.cwd ?? lastCwd ?? configuredCwd(command);
    return `${state}\nadb command: ${command}${device ? `\nDevice: ${deviceDisplayLabel(device)}` : ""}\nDevice cwd: ${cwd}\nResume: adb(action="reconnect")`;
  };

  const connectionResult = (summary: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: "text" as const, text: `${summary}\n${connectionDescription()}` }],
    details: {
      summary,
      connected: Boolean(device),
      command: device?.device.command ?? lastCommand ?? undefined,
      identity: device?.identity ?? lastIdentity,
      cwd: device?.cwd ?? lastCwd ?? (lastCommand ? configuredCwd(lastCommand) : undefined),
      toolRouting: routeDeviceTools ? "device" : "local",
      ...extra,
    },
  });

  const connectionErrorResult = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    details: { summary: message.split("\n")[0] },
    isError: true,
  });

  const mapPath = (path: string): string => {
    if (!device) return path;
    if (path === localCwd) return device.cwd;
    const prefix = localCwd.endsWith(sep) ? localCwd : localCwd + sep;
    if (path.startsWith(prefix)) return device.cwd.replace(/\/$/, "") + "/" + relative(localCwd, path).split(sep).join("/");
    return path;
  };

  const devicePath = (path: string): string => {
    const normalized = path.replace(/^@/, "");
    if (normalized.startsWith("/")) return mapPath(normalized);
    if (!device) return normalized;
    return posix.join(device.cwd, normalized);
  };

  const touchDevice = (): void => {
    if (device) device.lastSuccessAt = Date.now();
  };

  const currentSessionDeviceState = (): SessionDeviceState => device ? {
    version: 2,
    connected: true,
    identity: device.identity,
    command: device.device.command,
    cwd: device.cwd,
    routeDeviceTools,
    forwards: [...forwardSpecs.values()].map(serializeForwardSpec),
  } : {
    version: 2,
    connected: false,
    ...(lastIdentity ? { identity: lastIdentity } : {}),
    ...(lastCommand ? { command: lastCommand, cwd: lastCwd ?? configuredCwd(lastCommand) } : {}),
  };

  const persistSessionDeviceState = (): void => {
    if (!sessionReady || restoringSessionState) return;
    pi.appendEntry(SESSION_STATE_ENTRY_TYPE, currentSessionDeviceState());
  };

  const loadSessionDeviceState = (ctx: any): SessionDeviceState | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index] as any;
      if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) continue;
      const data = entry.data as Partial<SessionDeviceState> | undefined;
      // Foreign and version-1 (pre-conversion) entries are ignored rather than misapplied (F29).
      if (!data || data.version !== 2 || typeof data.connected !== "boolean") return undefined;
      if (data.connected && (typeof data.identity !== "string" || !data.identity.trim() || typeof data.command !== "string")) return undefined;
      return {
        version: 2,
        connected: data.connected,
        ...(typeof data.identity === "string" && data.identity.trim() ? { identity: data.identity.trim() } : {}),
        ...(typeof data.command === "string" && data.command.trim() ? { command: data.command.trim() } : {}),
        ...(typeof data.cwd === "string" && data.cwd ? { cwd: data.cwd } : {}),
        ...(typeof data.routeDeviceTools === "boolean" ? { routeDeviceTools: data.routeDeviceTools } : {}),
        ...(Array.isArray(data.forwards) ? { forwards: data.forwards.filter((value): value is string => typeof value === "string") } : {}),
      };
    }
    return undefined;
  };

  const limitDeviceToolResult = (result: any, kind: "read" | "exec", startLine = 1, requestedMaxLines?: number) => {
    const budgets = configuredOutputLimits();
    const configuredMaxBytes = kind === "read" ? budgets.readMaxBytes : budgets.execMaxBytes;
    const configuredMaxLines = kind === "read" ? budgets.readMaxLines : budgets.execMaxLines;
    const maxLines = Math.min(configuredMaxLines, requestedMaxLines ?? configuredMaxLines);
    const remaining = Math.max(0, budgets.turnMaxBytes - turnOutputBytes);
    if (remaining < MIN_MODEL_OUTPUT_BYTES) {
      const text = `[Device tool output omitted because this turn has used its ${formatSize(budgets.turnMaxBytes)} model-output budget. Run a narrower follow-up command.]`;
      turnOutputBytes += Buffer.byteLength(text, "utf8");
      return { ...result, content: [{ type: "text", text }], details: { ...(result.details ?? {}), turnBudgetExceeded: true } };
    }

    const maxBytes = Math.min(configuredMaxBytes, remaining);
    const textIndex = result.content?.findIndex((item: any) => item.type === "text") ?? -1;
    if (textIndex < 0) return result;
    const original = result.content[textIndex].text ?? "";
    const reserveBytes = result.details?.modelLimited ? 0 : OUTPUT_FOOTER_RESERVE_BYTES;
    const contentBudget = Math.max(1, maxBytes - reserveBytes);
    const truncation = kind === "read"
      ? truncateHead(original, { maxLines, maxBytes: contentBudget })
      : truncateTail(original, { maxLines, maxBytes: contentBudget });
    let text = truncation.content;
    let fullOutputPath = result.details?.fullOutputPath as string | undefined;
    if (truncation.firstLineExceedsLimit) {
      text = `[Line ${startLine} exceeds the ${formatSize(maxBytes)} device read limit. Use bash with sed/head -c to inspect a bounded fragment.]`;
    } else if (truncation.truncated) {
      if (kind === "read") {
        const nextOffset = startLine + truncation.outputLines;
        text += `\n\n[Showing ${truncation.outputLines} lines (${formatSize(maxBytes)} device read limit). Use offset=${nextOffset} to continue.]`;
      } else {
        fullOutputPath ??= saveOutput(original, scratchDir);
        text += `\n\n[Showing the last ${truncation.outputLines} lines (${formatSize(maxBytes)} device exec limit). Full output: ${fullOutputPath}]`;
      }
    }
    const content = [...result.content];
    content[textIndex] = { ...content[textIndex], text: text || (kind === "exec" ? "Device command completed." : "") };
    const actualBytes = Buffer.byteLength(content[textIndex].text, "utf8");
    turnOutputBytes += actualBytes;
    return {
      ...result,
      content,
      details: {
        ...(result.details ?? {}),
        ...(truncation.truncated ? { truncation } : {}),
        ...(fullOutputPath ? { fullOutputPath } : {}),
      },
    };
  };

  const status = (ctx: any) => {
    currentCtx = ctx;
    if (!device) ctx.ui.setStatus("adb-remote", undefined);
    else if (routeDeviceTools) ctx.ui.setStatus("adb-remote", ctx.ui.theme.fg("accent", deviceDisplayLabel(device, device.cwd)));
    else ctx.ui.setStatus("adb-remote", ctx.ui.theme.fg("accent", `forward ${[...forwardSpecs.keys()].join(",") || deviceDisplayLabel(device)}`));
  };

  /** `offline`/`authorizing` right after a replug are transient; give them a bounded window (F25). */
  const settleTransientState = async (parsed: ParsedDevice, transportSerial: string): Promise<AdbDeviceState> => {
    const deadline = Date.now() + TRANSIENT_STATE_MAX_MS;
    let latest: AdbDeviceState = await getState(parsed, transportSerial);
    while (latest !== "device" && latest !== "absent" && Date.now() < deadline) {
      await sleep(TRANSIENT_STATE_POLL_MS);
      latest = await getState(parsed, transportSerial);
    }
    return latest;
  };

  const resolveCwd = async (transport: AdbTransport, cwd: string): Promise<{ resolved: string; unavailableCwd?: string }> => {
    const attempt = async (target: string) =>
      await transport.exec(`cd -- ${quote(target)} && pwd -P`, "/", { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS });
    const first = await attempt(cwd);
    if (first.exitCode === 0 && first.stdout.toString("utf8").trim()) return { resolved: first.stdout.toString("utf8").trim() };
    if (cwd === DEFAULT_DEVICE_CWD) {
      throw new Error(`Device directory ${cwd} is not usable: ${first.stderr.toString("utf8").trim() || `exited with code ${first.exitCode}`}`);
    }
    const fallback = await attempt(DEFAULT_DEVICE_CWD);
    if (fallback.exitCode !== 0 || !fallback.stdout.toString("utf8").trim()) {
      throw new Error(`Device has no usable working directory (${cwd} and ${DEFAULT_DEVICE_CWD} both failed)`);
    }
    return { resolved: fallback.stdout.toString("utf8").trim(), unavailableCwd: cwd };
  };

  const establishDevice = async (parsed: ParsedDevice, cwd: string, ctx?: any): Promise<DeviceRuntime> => {
    await ensureServer(parsed);
    const hint = device && device.device.command === parsed.command ? device.transportSerial : lastTransportSerial(parsed);
    const resolution = await resolveIdentity(parsed, hint);
    if (resolution.kind === "absent") {
      throw new Error(`${recoveryHint("absent", parsed)}\nadb sees: ${resolution.candidates.map((entry) => `${entry.serial} (${entry.state})`).join(", ") || "no devices"}`);
    }
    if (resolution.kind === "collision") {
      throw new Error(`More than one attached device matches this endpoint (${resolution.matches.map((entry) => entry.serial).join(", ")}); refusing to guess which phone to control`);
    }
    if (resolution.kind === "ambiguous") {
      throw new Error(`${recoveryHint("ambiguous", parsed)}\nadb sees: ${resolution.candidates.map((entry) => `${entry.serial} (${entry.state})`).join(", ")}`);
    }
    const { transportSerial, entry } = resolution;
    const state = await settleTransientState(parsed, transportSerial);
    if (state !== "device") {
      throw new Error(`${recoveryHint(stateFailure(state), parsed)}\nDevice ${transportSerial} reported state "${state}"`);
    }
    const identityInfo = await readIdentityProps(parsed, transportSerial, entry.transportId);
    const capabilities = await probeCapabilities(parsed, transportSerial);
    const transport = new AdbTransport(parsed, transportSerial, capabilities, limits(), scratchDir);
    const now = Date.now();
    const { resolved, unavailableCwd } = await resolveCwd(transport, cwd);
    return {
      device: parsed,
      identity: identityInfo.identity,
      transportSerial,
      transport,
      capabilities,
      identityInfo,
      cwd: resolved,
      ...(unavailableCwd ? { unavailableCwd } : {}),
      lastSuccessAt: now,
      lastProbeAt: now,
    };
  };

  const lastTransportSerial = (parsed: ParsedDevice): string | undefined =>
    device && device.device.command === parsed.command ? device.transportSerial : undefined;

  const preflightDevice = async (ctx: any): Promise<DeviceRuntime> => {
    const current = device;
    if (!current) throw new Error("No device is connected");
    const observed = await getState(current.device, current.transportSerial);
    if (observed === "device") {
      current.lastProbeAt = Date.now();
      return current;
    }
    if (observed === "absent") {
      device = null;
      if (ctx) status(ctx);
      throw new Error(`${recoveryHint("absent", current.device)}\nThe transport serial ${current.transportSerial} is gone; use adb(action="reconnect") to re-resolve "${current.identity}".`);
    }
    const settled = await settleTransientState(current.device, current.transportSerial);
    if (settled === "device") {
      current.lastProbeAt = Date.now();
      return current;
    }
    throw new Error(`${recoveryHint(stateFailure(settled as Exclude<AdbDeviceState, "device">), current.device)}\nDevice ${current.transportSerial} is still ${settled}`);
  };

  const ensureDevice = async (ctx: any): Promise<DeviceRuntime> => {
    if (!device) {
      if (runtimeCache.resume) return reconnectDevice(ctx);
      const command = lastCommand || activeAdbCommand();
      if (!command) throw new Error(`No device endpoint configured; attach a phone and run /adb devices, or /adb connect adb -s <serial>`);
      const state = await connectInteractive(command, ctx, configuredCwd(command));
      if (!state) throw new Error(lastConnectionError || "Device connection was cancelled or failed");
      return state;
    }
    if (Date.now() - device.lastProbeAt <= STALE_DEVICE_STATE_MS) return device;
    try {
      return await preflightDevice(ctx);
    } catch (error) {
      throw new Error(deviceFailureMessage(error, device));
    }
  };

  /**
   * Read-class ops may be retried once after a reconnect; mutate-class ops never are, because a
   * doubled `input tap`, `pm install`, or file overwrite on a physical phone is not idempotent (F7).
   */
  const withDeviceRetry = async <T>(method: keyof typeof METHOD_CLASS, operation: (state: DeviceRuntime) => Promise<T>): Promise<T> => {
    const state = await ensureDevice(currentCtx);
    try {
      return await operation(state);
    } catch (error) {
      const failure = classifyAdbError(error instanceof Error ? error.message : String(error));
      if (METHOD_CLASS[method] !== "read" || failure === "other" || failure === "identity-collision") throw error;
      if (failure === "unauthorized") throw new Error(deviceFailureMessage(error, device));
      const reconnected = await reconnectDevice(currentCtx, true);
      return operation(reconnected);
    }
  };

  const changeDeviceCwd = (requested: string, ctx: any): Promise<string> => {
    // Single flight: the new cwd is only published after `pwd -P` returns, and every queued
    // chdir sees the previous one's result, so a running command keeps its snapshot (F26/F27).
    const run = async (): Promise<string> => {
      const state = await ensureDevice(ctx);
      // Bare `cd` means "the workspace I am in": the endpoint cwd, which chdir keeps current (V27).
      const target = requested.trim() || endpointConfig(loadDeviceConfig(), state.device.command).deviceCwd || DEFAULT_DEVICE_CWD;
      const result = await state.transport.exec(`cd -- ${quote(target)} && pwd -P`, state.cwd, { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS });
      const resolved = result.stdout.toString("utf8").trim();
      if (result.exitCode !== 0 || !resolved) {
        throw new Error(`Could not change to ${target}: ${result.stderr.toString("utf8").trim() || `exited with code ${result.exitCode}`}`);
      }
      device!.cwd = resolved;
      touchDevice();
      lastCommand = state.device.command;
      lastCwd = resolved;
      runtimeCache.resume = { identity: state.identity, command: state.device.command, cwd: resolved, routeDeviceTools, forwards: [...forwardSpecs.values()].map(serializeForwardSpec) };
      saveEndpointConfig(state.device.command, { deviceCwd: resolved }, true);
      status(ctx);
      persistSessionDeviceState();
      return resolved;
    };
    cwdQueue = cwdQueue.then(run, run);
    return cwdQueue as Promise<string>;
  };

  const standaloneCdTarget = (command: string): string | undefined => {
    try {
      const first = command.trim();
      if (!/^cd(\s|$)/.test(first) && !/^cd\s+--\s/.test(first)) return undefined;
      const tokens = first.split(/\s+/);
      if (tokens.length > 3) return undefined;
      if (tokens.length === 3 && tokens[1] !== "--") return undefined;
      const last = tokens.at(-1);
      // Empty string marks a bare `cd`, resolved to the endpoint cwd once the device is known.
      return last === "cd" || last === "--" ? "" : last;
    } catch {
      return undefined;
    }
  };

  const applyDevice = (next: DeviceRuntime, command: string): void => {
    device = next;
    routeDeviceTools = true;
    lastCommand = command;
    lastIdentity = next.identity;
    lastCwd = next.cwd;
    runtimeCache.resume = { identity: next.identity, command, cwd: next.cwd, routeDeviceTools, forwards: [...forwardSpecs.values()].map(serializeForwardSpec) };
    saveEndpointConfig(command, { deviceCwd: next.cwd }, true);
  };

  const reconnectDevice = async (ctx = currentCtx, quiet = false): Promise<DeviceRuntime> => {
    if (reconnectPromise) return reconnectPromise;
    const resumeRouting = device ? routeDeviceTools : (runtimeCache.resume?.routeDeviceTools ?? true);
    const source = device
      ? { command: device.device.command, cwd: device.cwd }
      : runtimeCache.resume
        ? { command: runtimeCache.resume.command, cwd: runtimeCache.resume.cwd }
        : null;
    if (!source) {
      if (!lastCommand) throw new Error("No device connection is available to reconnect");
      reconnectPromise = connectInteractive(lastCommand, ctx, lastCwd ?? configuredCwd(lastCommand), { wait: true })
        .then((state) => {
          if (!state) throw new Error(lastConnectionError || "Device reconnection was cancelled or failed");
          return state;
        })
        .finally(() => { reconnectPromise = null; });
      return reconnectPromise;
    }
    const previousCapabilities = device?.capabilities;
    const parsed = parseAdbCommand(source.command);
    reconnectPromise = (async () => {
      // Bounded wait: explicit reconnects are the one place `wait-for-device` is allowed.
      if (device) await waitForDevice(parsed, device.transportSerial, WAIT_FOR_DEVICE_SECONDS).catch(() => undefined);
      const next = await establishDevice(parsed, source.cwd, ctx);
      applyDevice({ ...next, lastProbeAt: Date.now() }, source.command);
      routeDeviceTools = resumeRouting;
      if (currentCtx) status(currentCtx);
      persistSessionDeviceState();
      if (previousCapabilities && capabilitySnapshot(previousCapabilities) !== capabilitySnapshot(next.capabilities) && !quiet) {
        const changed = (Object.keys(next.capabilities) as (keyof DeviceCapabilities)[])
          .filter((key) => previousCapabilities[key] !== next.capabilities[key])
          .map((key) => `${key}: ${String(previousCapabilities[key])} -> ${String(next.capabilities[key])}`);
        ctx?.ui.notify(`Device capabilities changed after reconnect: ${changed.join(", ") || "unknown change"}`, "warning");
      }
      if (!quiet) {
        ctx?.ui.notify(next.unavailableCwd
          ? `Device directory unavailable: ${next.unavailableCwd}; reconnected in ${next.cwd}`
          : `Device reconnected: ${deviceDisplayLabel(next, next.cwd)}`, "info");
      }
      return next;
    })().finally(() => { reconnectPromise = null; });
    return reconnectPromise;
  };

  const connectInteractive = async (command: string, ctx: any, cwd?: string, options: { wait?: boolean } = {}): Promise<DeviceRuntime | null> => {
    let parsed: ParsedDevice;
    try { parsed = parseAdbCommand(command); }
    catch (error) {
      lastConnectionError = (error as Error).message;
      ctx.ui.notify(lastConnectionError, "error");
      return null;
    }
    lastConnectionError = undefined;
    const targetCwd = cwd ?? configuredCwd(command);
    if (!device) {
      lastCommand = command;
      lastCwd = targetCwd;
      persistSessionDeviceState();
    }

    ctx.ui.setStatus("adb-remote", ctx.ui.theme.fg("warning", `connecting ${deviceCommandLabel(parsed)}…`));
    try {
      if (options.wait) await waitForDevice(parsed, undefined, WAIT_FOR_DEVICE_SECONDS).catch(() => undefined);
      const next = await establishDevice(parsed, targetCwd, ctx);
      applyDevice(next, command);
      lastConnectionError = undefined;
      status(ctx);
      persistSessionDeviceState();
      ctx.ui.notify(next.unavailableCwd
        ? `Device directory unavailable: ${next.unavailableCwd}; connected in ${next.cwd}`
        : `Device connected: ${deviceDisplayLabel(next, next.cwd)}`, "info");
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastConnectionError = classifyAdbError(message) === "unauthorized" ? recoveryHint("unauthorized", parsed) : message;
      device = null;
      status(ctx);
      ctx.ui.notify(`Device connection failed: ${lastConnectionError.split("\n")[0]}`, "error");
      return null;
    }
  };

  const startForward = async (spec: DeviceForwardSpec): Promise<void> => {
    if (forwardSpecs.has(spec.localPort)) return;
    const state = await ensureDevice(currentCtx);
    try {
      await state.transport.forward(spec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = classifyAdbError(message);
      if (failure === "forward-bind-conflict" || failure === "forward-rebind") {
        throw new Error(`Local port ${spec.localPort} is already forwarded or in use (${failure === "forward-rebind" ? "an adb forward already owns it" : "address already in use"}). Run \`adb forward --list\` or adb(action="status") to see who owns it.`);
      }
      throw error;
    }
    forwardSpecs.set(spec.localPort, spec);
  };

  /** Only ports this extension created are removed: `--remove-all` would clobber other tools (F11). */
  const stopForwards = async (ports: number[] = [...forwardSpecs.keys()]): Promise<void> => {
    if (!ports.length) return;
    const state = device;
    for (const port of ports) {
      try {
        if (state) await state.transport.unforward(port);
      } catch {}
      forwardSpecs.delete(port);
    }
  };

  const restoreSessionDeviceState = async (saved: SessionDeviceState, ctx: any): Promise<void> => {
    lastCommand = saved.command ?? "";
    lastIdentity = saved.identity;
    lastCwd = saved.cwd;
    if (!saved.connected) {
      runtimeCache.resume = undefined;
      status(ctx);
      return;
    }
    const command = saved.command!;
    const next = await connectInteractive(command, ctx, saved.cwd);
    if (!next) throw new Error(lastConnectionError || "Device session restore was cancelled or failed");
    if (saved.identity && saved.identity !== next.identity) {
      throw new Error(`The connected device reports identity "${next.identity}", but this session was saved for "${saved.identity}"; refusing to continue on the wrong phone`);
    }
    routeDeviceTools = saved.routeDeviceTools ?? true;
    const collisions: string[] = [];
    for (const value of saved.forwards ?? []) {
      const spec = parseForwardSpec(value);
      const owned = await next.transport.listForwards().catch(() => []);
      if (owned.some((entry) => entry.localPort === spec.localPort)) {
        collisions.push(value);
        continue;
      }
      await startForward(spec);
    }
    runtimeCache.resume = { identity: next.identity, command, cwd: next.cwd, routeDeviceTools, forwards: [...forwardSpecs.values()].map(serializeForwardSpec) };
    status(ctx);
    if (collisions.length) {
      ctx.ui.notify(`Skipped restored forwards already owned by another process: ${collisions.join(", ")}`, "warning");
    }
  };

  const disconnect = (ctx: any) => {
    if (device) {
      lastCommand = device.device.command;
      lastIdentity = device.identity;
      lastCwd = device.cwd;
    }
    void stopForwards();
    device = null;
    routeDeviceTools = false;
    reconnectPromise = null;
    runtimeCache.resume = undefined;
    status(ctx);
    persistSessionDeviceState();
    ctx.ui.notify("Device mode disabled; tools run locally again", "info");
  };

  const deviceReadOps = (): ReadOperations => ({
    readFile: (path) => withDeviceRetry("readBytes", async (state) => {
      const target = devicePath(path);
      const info = await state.transport.stat(target);
      if (!info) throw new Error(`No such device file: ${target}`);
      if (info.kind !== "file") throw new Error(`${target} is a ${info.kind}, not a regular file`);
      const cap = limits().imageMaxBytes;
      if (info.size > cap) {
        throw new Error(`${target} is ${info.size} bytes, above the ${formatSize(cap)} limit — use adb(action="pull") for large files`);
      }
      return state.transport.readBytes(target, cap);
    }),
    access: (path) => withDeviceRetry("stat", async (state) => {
      const target = devicePath(path);
      const info = await state.transport.stat(target);
      if (!info) throw new Error(`No such device path: ${target}`);
      if (info.kind === "dir") return;
      if (info.kind !== "file") throw new Error(`${target} is a ${info.kind}, not a file or directory`);
    }),
    detectImageMimeType: async (path) => {
      try {
        const sample = await withDeviceRetry("sampleBytes", (state) => state.transport.sampleBytes(devicePath(path), 512));
        const kind = sniffFileKind(sample, devicePath(path));
        return isImageMime(kind.mime) ? kind.mime : null;
      } catch {
        return null;
      }
    },
  });

  /** `writeBytes` reports atomicity; Pi's WriteOperations contract has nowhere to put it (F15). */
  const lastWriteResults = new Map<string, { atomic: boolean }>();

  const deviceWriteOps = (): WriteOperations => ({
    writeFile: async (path, content) => {
      const target = devicePath(path);
      const result = await withDeviceRetry("writeBytes", (state) =>
        state.transport.writeBytes(target, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")));
      lastWriteResults.set(target, result);
    },
    mkdir: (path) => withDeviceRetry("exec", async (state) => {
      const target = devicePath(path);
      const result = await state.transport.exec(`mkdir -p -- ${quote(target)}`, state.cwd, { timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS });
      if (result.exitCode !== 0) {
        throw new Error(`Could not create ${target}: ${result.stderr.toString("utf8").trim() || `exited with code ${result.exitCode}`}`);
      }
    }),
  });

  const deviceEditOps = (): EditOperations => {
    const read = deviceReadOps();
    const write = deviceWriteOps();
    return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
  };

  const statDeviceFile = async (target: string) =>
    withDeviceRetry("stat", async (state) => {
      const info = await state.transport.stat(target);
      if (!info) throw new Error(`No such device file: ${target}`);
      if (info.kind !== "file") throw new Error(`${target} is a ${info.kind}, not a regular file`);
      return info;
    });

  const executeDeviceRead = async (id: string, params: any, signal: AbortSignal | undefined, update: any) => {
    if (signal?.aborted) throw new Error("aborted");
    const target = devicePath(params.path);
    const info = await statDeviceFile(target);

    // Extension fast-path, then a magic sniff on the first bytes: `file --mime-type` does not
    // exist on the device (F5), so classification is entirely host-side.
    const declared = extensionMime(target);
    if (isImageMime(declared ?? "")) {
      const head = await withDeviceRetry("sampleBytes", (state) => state.transport.sampleBytes(target, SNIFF_SAMPLE_BYTES)).catch(() => undefined);
      if (!head || isImageMime(sniffFileKind(head, target).mime)) {
        const result = await createReadTool(localCwd, { operations: deviceReadOps() }).execute(id, params, signal, update);
        return limitDeviceToolResult(result, "read", params.offset ?? 1);
      }
    }

    // Sample the head before deciding anything: a large binary must be refused as binary (F5)
    // rather than as "too big", and 8 KB is the whole cost of finding out.
    const sample = await withDeviceRetry("sampleBytes", (state) => state.transport.sampleBytes(target, SNIFF_SAMPLE_BYTES));
    if (!looksLikeText(sample)) {
      throw new Error(`Refusing to read device binary file as text (${sniffFileKind(sample, target).mime}): ${params.path}`);
    }

    const budgets = configuredOutputLimits();
    const startLine = Math.max(1, Math.floor(Number(params.offset ?? 1)));
    const requestedLines = Math.max(1, Math.floor(Number(params.limit ?? budgets.readMaxLines)));
    const linesToFetch = Math.min(requestedLines, budgets.readMaxLines) + 1;
    const endLine = startLine + linesToFetch - 1;
    const transferBytes = Math.min(DEFAULT_MAX_BYTES, budgets.readMaxBytes + OUTPUT_FOOTER_RESERVE_BYTES + 4096);
    if (info.size > transferBytes && startLine === 1 && linesToFetch > budgets.readMaxLines) {
      // Nothing was transferred yet; say so before pulling a slice the model cannot read anyway.
      throw new Error(`${target} is ${info.size} bytes. Read it in ranges with offset/limit, or use adb(action="pull") to fetch it whole.`);
    }
    const bytes = await withDeviceRetry("readTextRange", (state) => {
      if (signal?.aborted) throw new Error("aborted");
      return state.transport.readTextRange(target, startLine, endLine, transferBytes);
    });
    if (signal?.aborted) throw new Error("aborted");
    if (!bytes.length && startLine > 1) throw new Error(`Offset ${startLine} is beyond end of device file`);
    if (!looksLikeText(bytes)) {
      throw new Error(`Refusing to read device binary file as text (${sniffFileKind(bytes, target).mime}): ${params.path}`);
    }
    const result = {
      content: [{ type: "text", text: bytes.toString("utf8") }],
      details: { deviceRange: { path: target, startLine, requestedLines: Math.min(requestedLines, budgets.readMaxLines) } },
    };
    return limitDeviceToolResult(result, "read", startLine, Math.min(requestedLines, budgets.readMaxLines));
  };

  const deviceBashOps = (): BashOperations => ({
    // The host `cwd` argument is Pi's project directory; the device cwd is ours (F26, D4b).
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const state = await ensureDevice(currentCtx);
      const timeoutSeconds = parseDeviceTimeout(timeout ?? DEFAULT_DEVICE_TIMEOUT_SECONDS);
      const snapshot = state.cwd;
      const budgets = configuredOutputLimits();
      const accumulator = new DeviceExecAccumulator(budgets.execMaxLines, budgets.execMaxBytes, SPILL_CAP_BYTES, scratchDir);
      const kill = new AbortController();
      const onCallerAbort = () => kill.abort();
      signal?.addEventListener("abort", onCallerAbort, { once: true });
      let capped = false;
      let stderrSample = Buffer.alloc(0);

      const stream = (chunk: Buffer) => {
        accumulator.append(chunk);
        onData(chunk);
        if (accumulator.hardCapHit && !capped) {
          capped = true;
          const note = Buffer.from(`\n[Device output exceeded ${formatSize(SPILL_CAP_BYTES)}; the command was stopped.]\n`, "utf8");
          accumulator.appendStderr(note);
          onData(note);
          kill.abort();
        }
      };
      const streamErr = (chunk: Buffer) => {
        stderrSample = Buffer.concat([stderrSample, chunk]).subarray(-4096);
        accumulator.appendStderr(chunk);
        onData(chunk);
      };

      try {
        const result = await state.transport.exec(command, snapshot, {
          timeoutSeconds,
          signal: kill.signal,
          onStdout: stream,
          onStderr: streamErr,
          maxCaptureBytes: SPILL_CAP_BYTES,
        });
        if (signal?.aborted) throw new Error("aborted");
        if (capped) return { exitCode: null };
        if (result.timedOut) throw new Error(`timeout:${timeoutSeconds}`);
        if (result.exitCode === 124 || result.exitCode === 137) throw new Error(`timeout:${timeoutSeconds}`);
        if (result.exitCode === 127 && /not found|inaccessible/i.test(stderrSample.toString("utf8"))) {
          const hint = Buffer.from(
            `\n[Hint: Pi's shell tools already run inside the Android device shell. Do not type \`adb shell ...\`; the missing program is genuinely absent from the device (no bash, no curl, no systemd).]\n`,
            "utf8",
          );
          accumulator.appendStderr(hint);
          onData(hint);
        }
        touchDevice();
        return { exitCode: result.exitCode };
      } catch (error) {
        if (capped) return { exitCode: null };
        throw error;
      } finally {
        accumulator.close();
        signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  });

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localLs = createLsTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);
  let localBash = createBashTool(localCwd);

  const routedToDevice = (path: unknown): boolean =>
    Boolean(device && routeDeviceTools && !targetsLocalDeviceMemory(path));

  const readGuard = (name: string): string =>
    `${name} cannot be routed to the device (it runs host ripgrep/fd). While device routing is active, use bash with the device's own tools instead: \`ls -a <dir>\`, \`grep -rn PATTERN <dir> | head\`, \`find <dir> -name '*.log' | head\`.`;

  const targetsLocalDeviceMemory = (path: unknown): boolean => {
    if (!device || typeof path !== "string") return false;
    return resolve(path.replace(/^@/, "")) === deviceMemoryFilePath(device.identity);
  };

  pi.registerTool({
    ...localRead,
    description: `Read file contents. Device text reads fetch only the requested range and return at most ${DEFAULT_READ_MAX_LINES} lines or ${formatSize(DEFAULT_READ_MAX_BYTES)} by default; use offset/limit to continue. ${DEVICE_FILE_TOOL_ROUTING_DESCRIPTION}`,
    promptGuidelines: ["Use read with offset/limit for device code and logs; inspect large files in focused chunks instead of reading them wholesale."],
    execute: (id: string, params: any, signal: AbortSignal | undefined, update: any) =>
      routedToDevice(params.path)
        ? executeDeviceRead(id, params, signal, update)
        : localRead.execute(id, params, signal, update),
  });
  pi.registerTool({
    ...localWrite,
    description: `${localWrite.description} ${DEVICE_FILE_TOOL_ROUTING_DESCRIPTION}`,
    execute: async (id: string, params: any, signal: AbortSignal | undefined, update: any) => {
      if (!routedToDevice(params.path)) return localWrite.execute(id, params, signal, update);
      const result = await createWriteTool(localCwd, { operations: deviceWriteOps() }).execute(id, params, signal, update);
      const target = devicePath(params.path);
      const written = lastWriteResults.get(target);
      lastWriteResults.delete(target);
      return {
        ...result,
        details: {
          ...(result.details ?? {}),
          ...(written ? { atomic: written.atomic } : {}),
          ...(written && !written.atomic ? { warning: "Staging directory unavailable; the file was written non-atomically." } : {}),
        },
      };
    },
  });
  pi.registerTool({
    ...localEdit,
    description: `${localEdit.description} ${DEVICE_FILE_TOOL_ROUTING_DESCRIPTION}`,
    execute: (id: string, params: any, signal: AbortSignal | undefined, update: any) =>
      routedToDevice(params.path)
        ? createEditTool(localCwd, { operations: deviceEditOps() }).execute(id, params, signal, update)
        : localEdit.execute(id, params, signal, update),
  });
  pi.registerTool({
    ...localBash,
    description: `Execute a shell command. Device model-facing output returns at most the last ${DEFAULT_EXEC_MAX_LINES} lines or ${formatSize(DEFAULT_EXEC_MAX_BYTES)} by default; complete oversized output is saved locally. ${DEVICE_SHELL_TOOL_ROUTING_DESCRIPTION}`,
    promptGuidelines: ["When using bash for device logs and broad searches, use bounded commands such as tail, sed, or grep with limits instead of cat or unbounded find output."],
    execute: async (id: string, params: any, signal: AbortSignal | undefined, update: any) => {
      if (!device || !routeDeviceTools) return localBash.execute(id, params, signal, update);
      const result = await createBashTool(localCwd, { operations: deviceBashOps() }).execute(id, params, signal, update);
      return limitDeviceToolResult(result, "exec");
    },
  });

  // SPIKE-4A said `ok`: these registrations do not re-enable a user-disabled tool, so they exist
  // purely to stop a routed session from silently returning PC results under a device-shaped name.
  for (const tool of [localLs, localGrep, localFind] as Parameters<typeof pi.registerTool>[0][]) {
    pi.registerTool({
      ...tool,
      execute: (id: string, params: any, signal: AbortSignal | undefined, update: any, toolCtx: any) =>
        device && routeDeviceTools
          ? Promise.reject(new Error(readGuard(tool.name)))
          : tool.execute(id, params, signal, update, toolCtx),
    });
  }

  const screenAction = async (params: any, ctx: any) => {
    const state = await ensureDevice(ctx);
    const png = await state.transport.screencap(parseDeviceTimeout(params.timeout ?? DEFAULT_DEVICE_TIMEOUT_SECONDS));
    const hostTarget = params.hostPath
      ? resolve(localCwd, String(params.hostPath).replace(/^@/, ""))
      : join(scratchDir, `screen-${Date.now()}.png`);
    if (!params.hostPath) {
      writeFileSync(hostTarget, png);
    } else {
      mkdirSync(dirname(hostTarget), { recursive: true });
      writeFileSync(hostTarget, png);
    }
    // A locked screen still produces a valid PNG (V32), so say what the capture probably shows.
    const wake = await state.transport
      .exec(`dumpsys power 2>/dev/null | grep -m1 -o 'mWakefulness=[a-zA-Z]*'`, state.cwd, { timeoutSeconds: 10 })
      .catch(() => undefined);
    const wakefulness = wake?.stdout.toString("utf8").trim().split("=")[1];
    const note = wakefulness && wakefulness !== "Awake" ? ` Device is ${wakefulness}; the capture is probably the lock screen.` : "";
    return {
      content: [
        { type: "text" as const, text: `Device screen captured (${formatSize(png.length)}): ${hostTarget}.${note}` },
        { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
      ],
      details: { action: "screen", hostPath: hostTarget, bytes: png.length, wakefulness },
    };
  };

  pi.registerTool({
    name: "adb",
    label: "ADB",
    description:
      "Connect, reconnect, list devices, annotate endpoints, locate device-specific memory, change the persistent device working directory, capture the screen, move files and APKs between the PC and the phone, run `adb forward` mappings, or execute a single device command. Every device interaction is one short-lived `adb` subprocess. Pi's read/write/edit/bash tools already run INSIDE the Android device shell when routing is active, so never type `adb shell ...`. Device commands run under POSIX `sh` (toybox/mksh): there is no bash, no curl, no systemd. Exec output is streamed to bounded buffers; model output defaults to the last 200 lines or 8 KB, with complete oversized output saved on the PC. Pairing codes are prompted through a hidden input widget and never stored.",
    promptSnippet: "Control the configured Android device: connect, endpoint note and memory, device cwd, screen capture, pull/push/install, port forwarding",
    promptGuidelines: [
      "Use adb when the user asks the agent to enter, re-probe, inspect, or leave a device environment; adb(action=\"devices\") shows what adb can currently see.",
      "Use adb(action=\"chdir\") to change the persistent device directory; do not emulate it with a one-command cwd.",
      "Device output can be enormous. Bound it: `logcat -d -t 200`, `getprop`, `dumpsys <service> | head -50`, `tail -n 200`, `pm list packages <filter>`.",
      "The device reaches only its own filesystem. Use adb(action=\"pull\"|\"push\"|\"install\") to cross between the PC and the phone; screen capture is adb(action=\"screen\").",
      "adb(action=\"uninstall\") and adb(action=\"install\") change the phone's state and are never retried automatically; confirm with the user first.",
      "Use adb(action=\"memory\") to locate the device-memory JSON file, then use read/edit/write on that exact local PC path for entry-level changes.",
      "Delete a device-memory JSON entry only after an explicit user request. Read the file first, identify the exact id, remove only that object with edit, and ask if the target is ambiguous.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "connect", "reconnect", "devices", "status", "disconnect", "pair",
        "forward", "unforward", "exec", "chdir", "note", "memory",
        "screen", "pull", "push", "install", "uninstall",
      ] as const),
      command: Type.Optional(Type.String({ description: "adb endpoint command for connect, such as `adb`, `adb -s <serial>`, or `adb -t <transport_id>`; also selects the endpoint for note or memory" })),
      note: Type.Optional(Type.String({ description: "Endpoint note for the note action; omit or use an empty string to clear it" })),
      cwd: Type.Optional(Type.String({ description: "Device working directory; required for chdir, and a one-command override for exec" })),
      forwards: Type.Optional(Type.String({ description: "Space-separated LOCAL_PORT:<tcp|localabstract|dev|jdwp>:NAME mappings; defaults to adb-remote-config.json" })),
      deviceCommand: Type.Optional(Type.String({ description: "Device shell command for the exec action (POSIX sh, no `adb shell` prefix)" })),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_DEVICE_TIMEOUT_SECONDS, description: `Device command timeout in seconds; defaults to ${DEFAULT_DEVICE_TIMEOUT_SECONDS}, installs default to ${DEFAULT_INSTALL_TIMEOUT_SECONDS}` })),
      displayLines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DISPLAY_LINES, description: "Collapsed visual lines for exec output; defaults to the /adb config display-lines setting (5 initially), maximum 50" })),
      devicePath: Type.Optional(Type.String({ description: "Absolute path on the device, for screen, pull, push, and the exec file helpers" })),
      hostPath: Type.Optional(Type.String({ description: "Path on this PC (relative paths resolve against the project directory), for screen, pull, push, and install" })),
      packageName: Type.Optional(Type.String({ description: "Application package name, for install verification and uninstall" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing destination file; required when pull or push would overwrite" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "status") {
        const ports = [...forwardSpecs.keys()].sort((a, b) => a - b);
        const caps = device ? Object.entries(device.capabilities).filter(([, value]) => value === true || value === false).map(([key, value]) => `${key}=${value}`).join(" ") : "";
        const text = `${device ? `Connected: ${deviceDisplayLabel(device, device.cwd)} (transport ${device.transportSerial}); tool routing: ${routeDeviceTools ? "device" : "local"}` : "No device is connected"}${ports.length ? `; forwarded ports: ${ports.join(", ")}` : ""}`;
        return connectionResult(text, { forwardedPorts: ports, capabilities: caps, transportSerial: device?.transportSerial, identity: device?.identity });
      }
      if (params.action === "devices") {
        const parsed = parseAdbCommand(params.command?.trim() || lastCommand || activeAdbCommand() || "adb");
        const entries = await listDevices(parsed);
        const rows = await Promise.all(entries.map(async (entry) => {
          const props = entry.state === "device"
            ? await readIdentityProps(parsed, entry.serial, entry.transportId).then((info) => `${info.props.model ?? entry.model ?? ""} API ${info.props.apiLevel ?? "?"}`).catch(() => "")
            : "";
          return `${entry.serial}\t${entry.state}\t${[entry.model, props].filter(Boolean).join(" ")}\ttransport_id=${entry.transportId ?? "?"}`;
        }));
        return {
          content: [{ type: "text" as const, text: rows.length ? rows.join("\n") : "No devices attached." }],
          details: { action: "devices", devices: entries },
        };
      }
      if (params.action === "disconnect") {
        disconnect(ctx);
        return connectionResult("Disconnected from the device and returned to local tools.");
      }
      if (params.action === "reconnect") {
        try {
          const state = await reconnectDevice(ctx);
          return connectionResult(`Reconnected: ${deviceDisplayLabel(state, state.cwd)}`);
        } catch (error) {
          return connectionErrorResult(deviceFailureMessage(error, device));
        }
      }
      if (params.action === "pair") {
        const target = (params.devicePath ?? params.command ?? "").trim() || await ctx.ui.input("Pairing target (IP:port from the phone):", "");
        if (!target) return connectionErrorResult("Wireless pairing needs the IP:port shown in the phone's pairing dialog.");
        const code = await askPasscode(ctx, "Pairing code", "");
        if (!code) return connectionErrorResult("Wireless pairing was cancelled.");
        const parsed = parseAdbCommand(lastCommand || activeAdbCommand() || "adb");
        const paired = await runAdb(subcommandArgv(parsed, undefined, ["pair", target, code]), { timeoutSeconds: 60, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES });
        const output = `${paired.stdout.toString("utf8")} ${paired.stderr.toString("utf8")}`.trim();
        if (paired.exitCode !== 0 || !/successfully paired/i.test(output)) {
          return connectionErrorResult(`Wireless pairing failed: ${output || `adb exited with code ${paired.exitCode}`}`);
        }
        return connectionResult(`Paired with ${target}. Connect with adb(action="connect", command="adb -s ${target}").`);
      }
      if (params.action === "unforward") {
        const removed = [...forwardSpecs.keys()];
        await stopForwards(removed);
        persistSessionDeviceState();
        return { content: [{ type: "text", text: removed.length ? `Removed extension-managed forwards: ${removed.join(", ")}` : "No extension-managed forwards were active." }], details: { forwardedPorts: [] } };
      }
      if (params.action === "forward") {
        const state = await ensureDevice(ctx);
        const values = params.forwards?.trim().split(/\s+/).filter(Boolean) ?? configuredForwards(state.device.command);
        if (!values.length) throw new Error(`No port mappings configured in ${ADB_CONFIG_FILE}`);
        const specs = values.map(parseForwardSpec);
        for (const spec of specs) await startForward(spec);
        routeDeviceTools = false;
        runtimeCache.resume = { identity: state.identity, command: state.device.command, cwd: state.cwd, routeDeviceTools, forwards: [...forwardSpecs.values()].map(serializeForwardSpec) };
        if (currentCtx) status(currentCtx);
        persistSessionDeviceState();
        const ports = specs.map((spec) => spec.localPort);
        return { content: [{ type: "text", text: `Forwarded local ports: ${ports.join(", ")}; tools remain local.` }], details: { toolRouting: "local", forwardedPorts: ports } };
      }
      if (params.action === "chdir") {
        if (!params.cwd) throw new Error("cwd is required for chdir");
        const resolved = await changeDeviceCwd(params.cwd, ctx);
        return { content: [{ type: "text", text: `Device working directory: ${resolved}` }], details: { connected: true, cwd: resolved } };
      }
      if (params.action === "screen") return await screenAction(params, ctx);
      if (params.action === "pull") {
        if (!params.devicePath) throw new Error("devicePath is required for pull");
        const state = await ensureDevice(ctx);
        const source = params.devicePath.startsWith("/") ? params.devicePath : posix.join(state.cwd, params.devicePath);
        const host = resolve(localCwd, (params.hostPath ?? posix.basename(source)).replace(/^@/, ""));
        await state.transport.pull(source, host, { overwrite: params.overwrite === true });
        const info = statSync(host);
        return { content: [{ type: "text", text: `Pulled ${source} (${formatSize(info.size)}) to ${host}` }], details: { action: "pull", devicePath: source, hostPath: host, bytes: info.size } };
      }
      if (params.action === "push") {
        if (!params.hostPath || !params.devicePath) throw new Error("push needs hostPath (on this PC) and devicePath (on the device)");
        const state = await ensureDevice(ctx);
        const source = resolve(localCwd, params.hostPath.replace(/^@/, ""));
        const destination = params.devicePath.startsWith("/") ? params.devicePath : posix.join(state.cwd, params.devicePath);
        await state.transport.push(source, destination, { overwrite: params.overwrite === true });
        return { content: [{ type: "text", text: `Pushed ${source} to ${destination}` }], details: { action: "push", hostPath: source, devicePath: destination } };
      }
      if (params.action === "install") {
        if (!params.hostPath) throw new Error("install needs hostPath: the APK on this PC");
        const state = await ensureDevice(ctx);
        const apk = resolve(localCwd, params.hostPath.replace(/^@/, ""));
        try {
          await state.transport.install(apk, { timeoutSeconds: parseDeviceTimeout(params.timeout ?? DEFAULT_INSTALL_TIMEOUT_SECONDS) });
        } catch (error) {
          if (error instanceof InstallFailure) {
            return connectionErrorResult(`${error.message}\nadb never auto-uninstalls: ask the user before adb(action="uninstall").`);
          }
          throw error;
        }
        return { content: [{ type: "text", text: `Installed ${apk}` }], details: { action: "install", hostPath: apk } };
      }
      if (params.action === "uninstall") {
        if (!params.packageName) throw new Error("packageName is required for uninstall");
        const state = await ensureDevice(ctx);
        const confirmed = await ctx.ui.confirm("Uninstall application", `Remove ${params.packageName} from ${deviceDisplayLabel(state)}? Its data is deleted and cannot be recovered.`);
        if (!confirmed) return connectionErrorResult(`Uninstall of ${params.packageName} was cancelled.`);
        await state.transport.uninstall(params.packageName);
        return { content: [{ type: "text", text: `Uninstalled ${params.packageName}` }], details: { action: "uninstall", packageName: params.packageName } };
      }
      if (params.action === "note" || params.action === "memory") {
        const command = params.command || lastCommand || activeAdbCommand();
        if (!command) throw new Error("No device endpoint configured; connect or select an endpoint first");
        const parsed = parseAdbCommand(command);
        if (params.action === "note") {
          const note = params.note?.trim() || undefined;
          saveEndpointConfig(command, { note });
          if (device && device.device.command === parsed.command && currentCtx) status(currentCtx);
          return {
            content: [{ type: "text", text: note ? `Device note updated (${parsed.label}): ${note}` : `Device note cleared (${parsed.label})` }],
            details: { endpoint: parsed.label, note },
          };
        }
        const identity = device?.identity ?? lastIdentity;
        if (!identity) throw new Error("Connect to the device once so its stable identity is known before using device memory");
        const path = ensureDeviceMemoryFile(identity);
        let memory: DeviceMemoryFile | undefined;
        try { memory = loadDeviceMemory(identity); }
        catch (error) {
          throw new Error(`Invalid device-memory JSON at ${path}: ${(error as Error).message}`);
        }
        const text = memory?.entries.length
          ? `Device memory (${deviceMemoryId(identity)}) is stored at ${path}:\n${JSON.stringify(memory.entries, null, 2)}`
          : `No device-memory entries are configured for ${deviceMemoryId(identity)}. Use write to create ${path} with schema {"device":"${deviceMemoryId(identity)}","entries":[]}, then use edit for entry-level changes.`;
        return { content: [{ type: "text", text }], details: { endpoint: parsed.label, device: deviceMemoryId(identity), path, entries: memory?.entries ?? [] } };
      }
      if (params.action === "exec") {
        const state = await ensureDevice(ctx);
        if (!params.deviceCommand) throw new Error("deviceCommand is required for exec");
        const cdTarget = params.cwd === undefined ? standaloneCdTarget(params.deviceCommand) : undefined;
        if (cdTarget !== undefined) {
          const resolved = await changeDeviceCwd(cdTarget, ctx);
          return { content: [{ type: "text", text: resolved }], details: { connected: true, cwd: resolved } };
        }
        const displayLines = parseDisplayLines(params.displayLines ?? configuredDisplayLines());
        const timeoutSeconds = parseDeviceTimeout(params.timeout ?? DEFAULT_DEVICE_TIMEOUT_SECONDS);
        const budgets = configuredOutputLimits();
        const accumulator = new DeviceExecAccumulator(budgets.execMaxLines, budgets.execMaxBytes, SPILL_CAP_BYTES, scratchDir);
        const cwd = params.cwd ? (String(params.cwd).startsWith("/") ? String(params.cwd) : posix.join(state.cwd, String(params.cwd))) : state.cwd;
        try {
          const result = await state.transport.exec(String(params.deviceCommand), cwd, {
            timeoutSeconds,
            onStdout: (chunk) => accumulator.append(chunk),
            onStderr: (chunk) => accumulator.appendStderr(chunk),
            maxCaptureBytes: SPILL_CAP_BYTES,
          });
          if (result.timedOut || result.exitCode === 124 || result.exitCode === 137) {
            throw new DeviceCommandError(`Device command timed out after ${timeoutSeconds} seconds`, result.exitCode, accumulator.errorMessage(), true);
          }
          touchDevice();
          const formatted = accumulator.finish();
          return limitDeviceToolResult({
            content: [{ type: "text", text: formatted.text }],
            details: {
              action: "exec",
              connected: true,
              cwd,
              displayLines,
              output: formatted.content,
              exitCode: result.exitCode,
              modelLimited: true,
              truncation: formatted.truncation.truncated ? formatted.truncation : undefined,
              fullOutputPath: formatted.fullOutputPath,
            },
          }, "exec");
        } finally {
          accumulator.close();
        }
      }
      const command = params.command || lastCommand || activeAdbCommand();
      if (!command) throw new Error(`No device endpoint configured. Set ${ADB_CONFIG_FILE} or pass command.`);
      const state = await connectInteractive(command, ctx, params.cwd ?? configuredCwd(command));
      if (!state) return connectionErrorResult(lastConnectionError || "Device connection was cancelled or failed");
      return connectionResult(`Connected: ${deviceDisplayLabel(state, state.cwd)}`);
    },
    renderCall(params, theme) {
      return renderAdbControlCall(params, theme);
    },
    renderResult(result, { expanded }, theme) {
      return renderAdbControlResult(result, expanded, theme);
    },
  });

  pi.registerCommand("adb", {
    description: `Connect to an Android device and manage endpoints: /adb | devices | connect [adb ...] | use <endpoint> | screen [PC_PATH] | pull DEVICE [PC_PATH] | push PC_PATH DEVICE | install APK | uninstall PACKAGE | exec [--timeout SECONDS] [--lines N] COMMAND | cd PATH | forward [MAPPINGS] | unforward | pair | status | reconnect | disconnect | memory | config note TEXT|--clear | config cwd PATH | config display-lines N | config read-max-lines|read-max-bytes|exec-max-lines|exec-max-bytes|turn-max-bytes|image-max-bytes N | config forward MAPPINGS`,
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => getDeviceArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const input = args.trim().replace(/^\/?adb(?:\s+|$)/i, "").trim();
      const action = input.toLowerCase();

      const needDevice = (): DeviceRuntime | undefined => {
        if (!device) ctx.ui.notify("Connect to a device first (/adb devices to see what is attached)", "error");
        return device ?? undefined;
      };
      const absoluteDevicePath = (value: string, state: DeviceRuntime): string =>
        value.startsWith("/") ? value : posix.join(state.cwd, value);

      if (action === "config") {
        const config = loadDeviceConfig();
        const rows = Object.entries(config.endpoints ?? {}).map(([key, endpoint]) => {
          const active = key === config.activeEndpoint ? "*" : " ";
          return `${active} ${key}\n    note: ${endpoint.note || "none"}\n    adb: ${endpoint.adbCommand}\n    cwd: ${endpoint.deviceCwd || DEFAULT_DEVICE_CWD}\n    image cap: ${formatSize(endpoint.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES)}\n    forward: ${endpoint.forwards?.join(", ") || "none"}`;
        });
        const budgets = configuredOutputLimits(config);
        ctx.ui.notify(`Device configuration: ${ADB_CONFIG_FILE}\nDisplay lines: ${configuredDisplayLines(config)}\nRead output: ${budgets.readMaxLines} lines / ${formatSize(budgets.readMaxBytes)}\nExec output: ${budgets.execMaxLines} lines / ${formatSize(budgets.execMaxBytes)}\nPer-turn output: ${formatSize(budgets.turnMaxBytes)}\n${rows.join("\n") || "No saved endpoints"}`, "info");
        return;
      }
      if (/^(?:connect\s*)?$/i.test(input) && !input) {
        const selected = lastCommand || activeAdbCommand();
        if (selected) {
          await connectInteractive(selected, ctx);
          return;
        }
        try {
          const entries = await listDevices(parseAdbCommand("adb"));
          ctx.ui.notify(entries.length
            ? `Attached devices:\n${entries.map((entry) => `  ${entry.serial} (${entry.state})`).join("\n")}\nConnect with: /adb connect adb -s <serial>`
            : "No devices attached. Enable USB debugging on the phone, then /adb devices", "info");
        } catch (error) {
          ctx.ui.notify(`Could not query adb: ${(error as Error).message}`, "error");
        }
        return;
      }
      if (/^devices(?:\s+|$)/i.test(input)) {
        try {
          const entries = await listDevices(parseAdbCommand(input.replace(/^devices\s*/i, "").trim() || lastCommand || activeAdbCommand() || "adb"));
          ctx.ui.notify(entries.length
            ? entries.map((entry) => `${entry.serial}\t${entry.state}\t${[entry.product, entry.model, entry.transportId ? `transport_id=${entry.transportId}` : ""].filter(Boolean).join(" ")}`).join("\n")
            : "No devices attached", "info");
        } catch (error) {
          ctx.ui.notify(`Could not list devices: ${(error as Error).message}`, "error");
        }
        return;
      }
      if (/^connect\s+/i.test(input)) {
        const raw = input.replace(/^connect\s+/i, "").trim();
        const command = /^adb(\s|$)/.test(raw) ? raw : `adb -s ${raw}`;
        try { parseAdbCommand(command); }
        catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
        saveEndpointConfig(command, {}, true);
        lastCommand = command;
        await connectInteractive(command, ctx);
        return;
      }
      if (/^(?:config\s+)?use\s+/i.test(input)) {
        const requested = input.replace(/^(?:config\s+)?use\s+/i, "").trim();
        const config = loadDeviceConfig();
        const keys = Object.keys(config.endpoints ?? {});
        const matches = keys.filter((key) => key === requested || key.startsWith(requested));
        if (matches.length !== 1) {
          ctx.ui.notify(matches.length ? `Endpoint name is ambiguous: ${matches.join(", ")}` : `Endpoint not found: ${requested}`, "error");
          return;
        }
        const key = matches[0]!;
        const command = config.endpoints?.[key]?.adbCommand;
        if (!command) { ctx.ui.notify(`Endpoint has no adb command: ${key}`, "error"); return; }
        if (device && device.device.command !== command) {
          void stopForwards();
          device = null;
          routeDeviceTools = false;
          runtimeCache.resume = undefined;
          status(ctx);
        }
        saveDeviceConfig({ ...config, activeEndpoint: key });
        lastCommand = command;
        lastCwd = configuredCwd(command);
        persistSessionDeviceState();
        ctx.ui.notify(`Selected device endpoint: ${deviceCommandLabel(parseAdbCommand(command))}; use /adb connect to attach`, "info");
        return;
      }
      if (/^config\s+note(?:\s+|$)/i.test(input)) {
        const value = input.replace(/^config\s+note\s*/i, "").trim();
        if (!value) { ctx.ui.notify("Use /adb config note TEXT or /adb config note --clear", "error"); return; }
        const command = lastCommand || activeAdbCommand();
        if (!command) { ctx.ui.notify("Configure a device endpoint first", "error"); return; }
        const note = value.toLowerCase() === "--clear" ? undefined : value;
        saveEndpointConfig(command, { note });
        if (device && device.device.command === command) status(ctx);
        ctx.ui.notify(note ? `Device note updated (${parseAdbCommand(command).label}): ${note}` : `Device note cleared (${parseAdbCommand(command).label})`, "info");
        return;
      }
      if (action === "memory") {
        const identity = device?.identity ?? lastIdentity;
        if (!identity) { ctx.ui.notify("Connect to the device once so its stable identity is known before using device memory", "error"); return; }
        let path: string;
        try { path = ensureDeviceMemoryFile(identity); }
        catch (error) { ctx.ui.notify(`Could not initialize device-memory JSON: ${(error as Error).message}`, "error"); return; }
        try {
          const memory = loadDeviceMemory(identity);
          ctx.ui.notify(`Device memory (${deviceMemoryId(identity)})\nFile: ${path}\n\n${formatDeviceMemoryEntries(memory)}`, "info");
        } catch (error) {
          ctx.ui.notify(`Invalid device-memory JSON at ${path}: ${(error as Error).message}`, "error");
        }
        return;
      }
      if (/^config\s+display-lines\s+/i.test(input)) {
        try {
          const displayLines = parseDisplayLines(input.replace(/^config\s+display-lines\s*/i, "").trim());
          saveDeviceConfig({ ...loadDeviceConfig(), displayLines });
          ctx.ui.notify(`Device command preview updated: ${displayLines} lines`, "info");
        } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
        return;
      }
      const outputConfig = input.match(/^config\s+(read-max-lines|read-max-bytes|exec-max-lines|exec-max-bytes|turn-max-bytes)\s+(\S+)$/i);
      if (outputConfig) {
        try {
          const key = outputConfig[1]!.toLowerCase();
          const value = outputConfig[2]!;
          const config = loadDeviceConfig();
          if (key === "read-max-lines") config.readMaxLines = parseOutputLines(value, "Read max lines");
          else if (key === "read-max-bytes") config.readMaxBytes = parseOutputBytes(value, "Read max bytes");
          else if (key === "exec-max-lines") config.execMaxLines = parseOutputLines(value, "Exec max lines");
          else if (key === "exec-max-bytes") config.execMaxBytes = parseOutputBytes(value, "Exec max bytes");
          else config.turnMaxBytes = parseOutputBytes(value, "Turn max bytes", DEFAULT_MAX_BYTES * 4);
          saveDeviceConfig(config);
          ctx.ui.notify(`Device output limit updated: ${key}=${value}`, "info");
        } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
        return;
      }
      if (/^config\s+image-max-bytes\s+/i.test(input)) {
        const command = lastCommand || activeAdbCommand();
        if (!command) { ctx.ui.notify("Configure a device endpoint first", "error"); return; }
        try {
          const imageMaxBytes = parseImageMaxBytes(input.replace(/^config\s+image-max-bytes\s+/i, "").trim());
          saveEndpointConfig(command, { imageMaxBytes });
          if (device) device.transport = new AdbTransport(device.device, device.transportSerial, device.capabilities, limits(), scratchDir);
          ctx.ui.notify(`Device image cap updated: ${formatSize(imageMaxBytes)}`, "info");
        } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
        return;
      }
      if (/^config\s+cwd\s+/i.test(input)) {
        const deviceCwd = input.replace(/^config\s+cwd\s+/i, "").trim();
        const command = lastCommand || activeAdbCommand();
        if (!command) { ctx.ui.notify("Configure a device endpoint first", "error"); return; }
        saveEndpointConfig(command, { deviceCwd });
        lastCwd = deviceCwd;
        persistSessionDeviceState();
        ctx.ui.notify(`Default device directory updated (${parseAdbCommand(command).label}): ${deviceCwd}`, "info");
        return;
      }
      if (/^config\s+forward(?:\s+|$)/i.test(input)) {
        const forwards = input.replace(/^config\s+forward\s*/i, "").trim().split(/\s+/).filter(Boolean);
        try { forwards.forEach(parseForwardSpec); }
        catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
        const command = lastCommand || activeAdbCommand();
        if (!command) { ctx.ui.notify("Configure a device endpoint first", "error"); return; }
        saveEndpointConfig(command, { forwards });
        ctx.ui.notify(`Device port-forward configuration updated (${parseAdbCommand(command).label}): ${forwards.join(", ") || "none"}`, "info");
        return;
      }
      if (/^forward(?:\s+|$)/i.test(input)) {
        try {
          const state = await ensureDevice(ctx);
          const supplied = input.replace(/^forward\s*/i, "").trim();
          const values = supplied ? supplied.split(/\s+/) : configuredForwards(state.device.command);
          if (!values.length) throw new Error(`No port forwards configured; use /adb config forward LOCAL_PORT:<tcp|localabstract|dev|jdwp>:NAME`);
          const specs = values.map(parseForwardSpec);
          for (const spec of specs) await startForward(spec);
          routeDeviceTools = false;
          runtimeCache.resume = { identity: state.identity, command: state.device.command, cwd: state.cwd, routeDeviceTools, forwards: [...forwardSpecs.values()].map(serializeForwardSpec) };
          status(ctx);
          persistSessionDeviceState();
          ctx.ui.notify(`Device port forwarding started; tools remain local in ${localCwd}: localhost:${specs.map((spec) => spec.localPort).join(", ")}`, "info");
        } catch (error) { ctx.ui.notify(`Device port forwarding failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (action === "unforward") {
        const removed = [...forwardSpecs.keys()];
        await stopForwards(removed);
        persistSessionDeviceState();
        ctx.ui.notify(removed.length ? `Removed extension-managed forwards: ${removed.join(", ")}` : "No extension-managed forwards were active", "info");
        return;
      }
      if (/^screen(?:\s+|$)/i.test(input)) {
        try {
          const hostPath = input.replace(/^screen\s*/i, "").trim() || undefined;
          const result = await screenAction({ hostPath }, ctx);
          ctx.ui.notify(String(result.content[0]?.text ?? ""), "info");
        } catch (error) { ctx.ui.notify(`Screen capture failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (/^pull\s+/i.test(input)) {
        const state = needDevice();
        if (!state) return;
        const [source, target] = input.replace(/^pull\s+/i, "").trim().split(/\s+/);
        if (!source) { ctx.ui.notify("Use /adb pull DEVICE_PATH [PC_PATH]", "error"); return; }
        try {
          const host = resolve(localCwd, target ?? posix.basename(source));
          await state.transport.pull(absoluteDevicePath(source, state), host, { overwrite: true });
          ctx.ui.notify(`Pulled ${absoluteDevicePath(source, state)} (${formatSize(statSync(host).size)}) to ${host}`, "info");
        } catch (error) { ctx.ui.notify(`Pull failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (/^push\s+/i.test(input)) {
        const state = needDevice();
        if (!state) return;
        const [source, target] = input.replace(/^push\s+/i, "").trim().split(/\s+/);
        if (!source || !target) { ctx.ui.notify("Use /adb push PC_PATH DEVICE_PATH", "error"); return; }
        try {
          const host = resolve(localCwd, source);
          await state.transport.push(host, absoluteDevicePath(target, state), { overwrite: true });
          ctx.ui.notify(`Pushed ${host} to ${absoluteDevicePath(target, state)}`, "info");
        } catch (error) { ctx.ui.notify(`Push failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (/^install\s+/i.test(input)) {
        const state = needDevice();
        if (!state) return;
        const apk = resolve(localCwd, input.replace(/^install\s+/i, "").trim());
        if (!apk) { ctx.ui.notify("Use /adb install PATH.TO/APK", "error"); return; }
        try {
          await state.transport.install(apk, { timeoutSeconds: DEFAULT_INSTALL_TIMEOUT_SECONDS });
          ctx.ui.notify(`Installed ${apk}`, "info");
        } catch (error) {
          ctx.ui.notify(`Install failed: ${(error as Error).message}`, "error");
        }
        return;
      }
      if (/^uninstall\s+/i.test(input)) {
        const state = needDevice();
        if (!state) return;
        const packageName = input.replace(/^uninstall\s+/i, "").trim();
        if (!packageName) { ctx.ui.notify("Use /adb uninstall PACKAGE.NAME", "error"); return; }
        const confirmed = await ctx.ui.confirm("Uninstall application", `Remove ${packageName} from ${deviceDisplayLabel(state)}? Its data is deleted and cannot be recovered.`);
        if (!confirmed) { ctx.ui.notify("Uninstall cancelled", "info"); return; }
        try {
          await state.transport.uninstall(packageName);
          ctx.ui.notify(`Uninstalled ${packageName}`, "info");
        } catch (error) { ctx.ui.notify(`Uninstall failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (/^pair(?:\s+|$)/i.test(input)) {
        const target = input.replace(/^pair\s*/i, "").trim() || await ctx.ui.input("Pairing target (IP:port from the phone):", "");
        if (!target) { ctx.ui.notify("Wireless pairing needs the IP:port shown in the phone's pairing dialog", "error"); return; }
        const code = await askPasscode(ctx, "Pairing code", "");
        if (!code) { ctx.ui.notify("Pairing cancelled", "info"); return; }
        try {
          const paired = await runAdb(subcommandArgv(parseAdbCommand(lastCommand || "adb"), undefined, ["pair", target, code]), { timeoutSeconds: 60, maxCaptureBytes: CONTROL_MAX_CAPTURE_BYTES });
          const output = `${paired.stdout.toString("utf8")} ${paired.stderr.toString("utf8")}`.trim();
          if (paired.exitCode === 0 && /successfully paired/i.test(output)) ctx.ui.notify(`Paired with ${target}; connect with /adb connect adb -s ${target}`, "info");
          else ctx.ui.notify(`Pairing failed: ${output || `adb exited with code ${paired.exitCode}`}`, "error");
        } catch (error) { ctx.ui.notify(`Pairing failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (/^exec\s+/i.test(input)) {
        try {
          const state = await ensureDevice(ctx);
          let execInput = input.replace(/^exec\s+/i, "").trim();
          let displayLines = configuredDisplayLines();
          let timeoutSeconds = DEFAULT_DEVICE_TIMEOUT_SECONDS;
          while (execInput.startsWith("--")) {
            const option = execInput.match(/^--(lines|timeout)\s+(\S+)\s+([\s\S]+)$/i);
            if (!option) throw new Error("Expected --lines N or --timeout SECONDS followed by a command");
            if (option[1]!.toLowerCase() === "lines") displayLines = parseDisplayLines(option[2]);
            else timeoutSeconds = parseDeviceTimeout(option[2]);
            execInput = option[3]!;
          }
          const budgets = configuredOutputLimits();
          const accumulator = new DeviceExecAccumulator(budgets.execMaxLines, budgets.execMaxBytes, SPILL_CAP_BYTES, scratchDir);
          try {
            const result = await state.transport.exec(execInput, state.cwd, {
              timeoutSeconds,
              onStdout: (chunk) => accumulator.append(chunk),
              onStderr: (chunk) => accumulator.appendStderr(chunk),
              maxCaptureBytes: SPILL_CAP_BYTES,
            });
            if (result.timedOut || result.exitCode === 124 || result.exitCode === 137) {
              throw new Error(`Device command timed out after ${timeoutSeconds} seconds`);
            }
            touchDevice();
            const formatted = accumulator.finish();
            const preview = previewDeviceOutput(formatted.content, displayLines);
            const omitted = formatted.truncation.totalLines > displayLines
              ? `\n\n[Showing last ${Math.min(displayLines, formatted.truncation.totalLines)} of ${formatted.truncation.totalLines} lines]`
              : "";
            const fullOutput = formatted.fullOutputPath ? `\n[Full output: ${formatted.fullOutputPath}]` : "";
            ctx.ui.notify(`${preview}${omitted}${fullOutput}`, "info");
          } finally {
            accumulator.close();
          }
        } catch (error) { ctx.ui.notify(`Device command failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (["disconnect", "off", "exit"].includes(action)) { disconnect(ctx); return; }
      if (action === "status") {
        ctx.ui.notify(connectionDescription(), "info");
        return;
      }
      if (action === "reconnect") {
        try { await reconnectDevice(ctx); }
        catch (error) { ctx.ui.notify(`Device reconnection failed: ${(error as Error).message.split("\n")[0]}`, "error"); }
        return;
      }
      if (/^cd(?:\s+|$)/i.test(input)) {
        if (!device) { ctx.ui.notify("Connect to a device first", "error"); return; }
        const requested = input.replace(/^cd\s*/i, "").trim() || DEFAULT_DEVICE_CWD;
        try {
          const resolved = await changeDeviceCwd(requested, ctx);
          ctx.ui.notify(`Device path: ${resolved}`, "info");
        } catch (error) { ctx.ui.notify(`Failed to change device path: ${(error as Error).message}`, "error"); }
        return;
      }
      if (/^adb(\s|$)/i.test(input)) {
        saveEndpointConfig(input, {}, true);
        lastCommand = input;
        await connectInteractive(input, ctx);
        return;
      }
      await connectInteractive(`adb -s ${input}`, ctx);
    },
  });

  pi.on("turn_start", () => { turnOutputBytes = 0; });
  pi.on("session_start", async (event, ctx) => {
    // Pi's shell settings configure the LOCAL bash only; they must never reach device commands.
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    localBash = createBashTool(ctx.cwd, {
      shellPath: settings.getShellPath(),
      commandPrefix: settings.getShellCommandPrefix(),
    });
    currentCtx = ctx;
    sessionReady = true;
    ctx.ui.addAutocompleteProvider(suppressDeviceCompletionsBeforeSuffix);
    status(ctx);
    const saved = loadSessionDeviceState(ctx);
    const canInheritCurrent = event.reason === "reload" || event.reason === "new" || event.reason === "fork";
    const inherited = !saved && canInheritCurrent && runtimeCache.resume ? runtimeCache.resume : undefined;
    const target: SessionDeviceState | undefined = saved ?? (inherited ? {
      version: 2,
      connected: true,
      identity: inherited.identity,
      command: inherited.command,
      cwd: inherited.cwd,
      routeDeviceTools: inherited.routeDeviceTools,
      forwards: inherited.forwards ?? [],
    } : undefined);
    if (!target) {
      runtimeCache.resume = undefined;
      return;
    }
    restoringSessionState = true;
    try {
      await restoreSessionDeviceState(target, ctx);
    } catch (error) {
      ctx.ui.notify(`Device session restore failed: ${(error as Error).message.split("\n")[0]}`, "error");
    } finally {
      restoringSessionState = false;
    }
    if (inherited && device) persistSessionDeviceState();
  });
  pi.on("session_shutdown", async (event) => {
    sessionReady = false;
    const preserveConnection = event.reason === "reload" || event.reason === "new" || event.reason === "fork";
    if (device && preserveConnection) {
      runtimeCache.resume = {
        identity: device.identity,
        command: device.device.command,
        cwd: device.cwd,
        routeDeviceTools,
        forwards: [...forwardSpecs.values()].map(serializeForwardSpec),
      };
    }
    device = null;
    routeDeviceTools = false;
    await stopForwards();
    if (!preserveConnection) {
      runtimeCache.resume = undefined;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
  pi.on("user_bash", async (event, ctx) => {
    if (!device || !routeDeviceTools) return undefined;
    const cdTarget = standaloneCdTarget(event.command);
    if (cdTarget === undefined) return { operations: deviceBashOps() };
    try {
      const resolved = await changeDeviceCwd(cdTarget, ctx);
      return { result: { output: resolved, exitCode: 0, cancelled: false, truncated: false } };
    } catch (error) {
      return { result: { output: (error as Error).message, exitCode: 1, cancelled: false, truncated: false } };
    }
  });
  pi.on("before_agent_start", (event) => {
    if (device || lastCommand) {
      event.systemPromptOptions.sections.adb_remote_connection = connectionDescription();
    }
    if (!device || !routeDeviceTools) return;
    event.systemPromptOptions.cwd = device.cwd;
    event.systemPromptOptions.sections.adb_remote_workspace = deviceWorkspacePrompt(device);
    event.systemPromptOptions.sections.adb_remote_memory_management = memoryManagementPrompt(device);
  });
  pi.on("context", (event) => {
    if (!device || !routeDeviceTools) return undefined;
    const content = deviceMemoryContext(device);
    if (!content) return undefined;
    const messages = event.messages.filter((message) =>
      message.role !== "custom" || message.customType !== "adb-remote-server-memory"
    );
    return {
      messages: [{
        role: "custom",
        customType: "adb-remote-server-memory",
        content,
        display: false,
        timestamp: Date.now(),
      }, ...messages],
    };
  });
}
