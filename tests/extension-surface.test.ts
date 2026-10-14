import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createHarness, text } from "./helpers/extension-harness.ts";

// ---------------------------------------------------------------------------
// Control-tool surface suite (plan §6 step 8). Asserts the exact calls the
// extension makes on Pi's extension API, the action vocabulary and renderers of
// the `adb` tool, and every PC-bridge action (screen, pull, push, install,
// uninstall, pair, forward) end to end against the fake device.
//
// Pi's built-in tools reject rather than return `isError` when driven directly,
// so expected failures go through `settle()`, which mirrors what the agent loop
// turns a rejection into.
// ---------------------------------------------------------------------------

// A 1x1 PNG, standing in for `exec-out screencap -p` output (V31).
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const root = mkdtempSync(join(tmpdir(), "pi-adb-surface-"));
const deviceRoot = join(root, "device");
const workspace = join(deviceRoot, "ws");
const hostDir = join(root, "host");
const agentDir = join(root, "agent");
const spawnLog = join(root, "spawn.log");
const PAIR_CODE = "SECRETCODE9876543";

const PLAN_FILE = new URL("../ARCHITECTURE_PLAN_adb-remote-transport.md", import.meta.url).pathname;
const recordedResult = /SPIKE-4A-RESULT:\s*(\w+)/.exec(readFileSync(PLAN_FILE, "utf8"))?.[1];

const fakeAdb = join(root, "fake-adb");
mkdirSync(workspace, { recursive: true });
mkdirSync(hostDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
copyFileSync(new URL("./fixtures/fake-adb.sh", import.meta.url), fakeAdb);
chmodSync(fakeAdb, 0o755);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.ADB = fakeAdb;
process.env.FAKE_ADB_ROOT = deviceRoot;
process.env.FAKE_ADB_LOG = spawnLog;
process.env.FAKE_ADB_PNG = join(root, "screen.png");
process.env.FAKE_ADB_PAIR_CODE = PAIR_CODE;
writeFileSync(process.env.FAKE_ADB_PNG, PNG_BYTES);
for (const name of ["FAKE_ADB_STATE", "FAKE_ADB_FORWARD_ERROR", "FAKE_ADB_TRANSFER_ERROR", "FAKE_ADB_INSTALL_FAILURE", "FAKE_ADB_PAIR_ERROR", "FAKE_ADB_UNINSTALL_FAILURE"]) {
  delete process.env[name];
}
writeFileSync(join(agentDir, "adb-remote-config.json"), `${JSON.stringify({
  activeEndpoint: "adb",
  endpoints: { adb: { adbCommand: "adb", deviceCwd: workspace, forwards: ["19000:tcp:8080"] } },
}, null, 2)}\n`);

// Relative hostPath values resolve against the PC project directory, so the suite runs with the
// sandbox as its cwd: a test can never write into the repository.
process.chdir(hostDir);

const privateTmp = join(root, "tmp");
mkdirSync(privateTmp, { recursive: true });
process.env.TMPDIR = privateTmp;
const scratchDirs = () => readdirSync(privateTmp).filter((name) => name.startsWith("pi-adb-remote-"));

const harness = createHarness({ cwd: workspace });
const registrations = { tools: [] as string[], commands: [] as string[], events: [] as string[] };
const inner = harness.api as any;
const { default: adbRemote } = await import("../index.ts");
adbRemote({
  registerTool: (tool: any) => { registrations.tools.push(tool.name); inner.registerTool(tool); },
  registerCommand: (name: string, options: any) => { registrations.commands.push(name); inner.registerCommand(name, options); },
  on: (event: string, handler: any) => { registrations.events.push(event); inner.on(event, handler); },
  appendEntry: () => {},
} as never);

// The collapsed renderer asks Pi for the expand key hint, which needs the theme module initialised.
initTheme(undefined, false);

const theme = { fg: (_key: string, value: string) => value, bold: (value: string) => value };
const adb = (params: any) => harness.callTool("adb", params);
/** Drive a call that is expected to fail and return the result shape the model would see. */
const settle = async (promise: Promise<any>) => {
  try {
    return await promise;
  } catch (error) {
    return { content: [{ type: "text", text: (error as Error).message }], details: { thrown: true }, isError: true };
  }
};
const spawnLines = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean) : []);
const clearSpawns = () => writeFileSync(spawnLog, "");
// The real theme tints the key hint, so rendering assertions strip the colour codes first.
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");
const lines = (component: any) => component.render(72).map((line: any) => stripAnsi(String(line.text ?? line)).trimEnd());

after(async () => {
  // session_shutdown owns the per-session spill directory; the private TMPDIR makes the check
  // independent of other test files running concurrently.
  await harness.fire("session_shutdown", { reason: "exit" });
  assert.deepEqual(scratchDirs(), [], "session_shutdown removed the scratch directory");
  delete process.env.FAKE_ADB_PNG;
  delete process.env.FAKE_ADB_PAIR_CODE;
  rmSync(root, { recursive: true, force: true });
});

describe("adb control tool surface", () => {
  it("makes exactly the recorded extension-API calls", () => {
    const guards = recordedResult === "ok" ? ["ls", "grep", "find"] : [];
    assert.deepEqual(registrations.tools, ["read", "write", "edit", "bash", ...guards, "adb"]);
    assert.deepEqual(registrations.commands, ["adb"], "there is exactly one command and it is /adb");
    assert.deepEqual(registrations.events, ["turn_start", "session_start", "session_shutdown", "user_bash", "before_agent_start", "context"]);
  });

  it("enumerates the adb actions and has no `forget`", () => {
    const schema: any = harness.tools.get("adb").parameters;
    assert.deepEqual(schema.required, ["action"]);
    const actions: string[] = schema.properties.action.enum;
    assert.deepEqual(actions, [
      "connect", "reconnect", "devices", "status", "disconnect", "pair",
      "forward", "unforward", "exec", "chdir", "note", "memory",
      "screen", "pull", "push", "install", "uninstall",
    ]);
    assert.ok(!actions.includes("forget"), "no credentials exist, so there is nothing to forget");
    const description: string = harness.tools.get("adb").description;
    assert.match(description, /already run INSIDE the Android device shell/i);
    assert.match(description, /no bash, no curl, no systemd/i);
  });

  it("refuses an action outside the vocabulary instead of falling through to connect", async () => {
    const rejected = await settle(adb({ action: "reboot" }));
    assert.equal(rejected.isError, true);
    assert.match(text(rejected), /Unknown adb action "reboot"\. Valid actions: connect/);
    assert.match(text(await adb({ action: "status" })), /No device is connected/);
  });

  it("renders every action call", () => {
    const tool = harness.tools.get("adb");
    const samples: Record<string, any> = {
      connect: { command: "adb" }, reconnect: {}, devices: { command: "adb" }, status: {}, disconnect: {},
      pair: { devicePath: "10.0.0.5:37001" }, forward: { forwards: "19000:tcp:8080" }, unforward: {},
      exec: { deviceCommand: "getprop" }, chdir: { cwd: "/sdcard" }, note: { note: "test phone" }, memory: {},
      screen: {}, pull: { devicePath: "/data/local/tmp/a" }, push: { devicePath: "/sdcard/a" },
      install: { hostPath: "a.apk" }, uninstall: { packageName: "org.example.app" },
    };
    for (const [action, args] of Object.entries(samples)) {
      const rendered = lines(tool.renderCall({ action, ...args }, theme));
      assert.equal(rendered.length > 0, true, `${action} renders at least one line`);
      assert.match(rendered.join("\n"), new RegExp(`adb ${action}\\b`), `${action} call rendering`);
    }
  });

  it("collapses exec output to the display budget and expands on demand", async () => {
    await adb({ action: "connect", command: "adb" });
    const result = await adb({ action: "exec", deviceCommand: "seq 1 40", displayLines: 5 });
    assert.equal(result.details.exitCode, 0);
    assert.equal(result.details.cwd, workspace, "exec ran in the endpoint cwd");
    const collapsed = lines(harness.tools.get("adb").renderResult(result, { expanded: false }, theme));
    assert.match(collapsed.join("\n"), /\(\d+ earlier lines, .* to expand\)/);
    assert.ok(collapsed.length <= 8, `collapsed stays short: ${collapsed.length} lines`);
    assert.ok(collapsed[collapsed.length - 2]?.includes("40"), `the tail stays visible: ${collapsed.join("|")}`);
    const expanded = lines(harness.tools.get("adb").renderResult(result, { expanded: true }, theme));
    assert.ok(expanded.length >= 40, `expansion shows all 40 lines, saw ${expanded.length}`);
    assert.equal(expanded[0], "1");
  });

  it("captures the screen as a PNG on the PC", async () => {
    const result = await adb({ action: "screen" });
    const image = (result.content ?? []).find((block: any) => block.type === "image");
    assert.equal(image.mimeType, "image/png", text(result));
    assert.deepEqual(Buffer.from(image.data, "base64"), PNG_BYTES);
    const saved = result.details.hostPath as string;
    assert.ok(existsSync(saved), `the capture was saved to ${saved}`);
    assert.equal(readFileSync(saved).subarray(1, 4).toString("utf8"), "PNG");
    assert.match(text(result), /Device screen captured \(\d+(?:\.\d+)?[KMG]?B\)/);
    assert.equal(result.details.wakefulness, undefined, "a device without dumpsys yields no lock-screen note");

    // An explicit hostPath is the documented PC destination; relative paths resolve on the PC.
    const explicit = await adb({ action: "screen", hostPath: "shots/here.png" });
    const target = join(hostDir, "shots", "here.png");
    assert.equal(explicit.details.hostPath, target, explicit.details.hostPath);
    assert.ok(existsSync(target), "the PNG landed on the PC");
    assert.equal(readFileSync(target).subarray(1, 4).toString("utf8"), "PNG");
  });

  it("moves files in both directions and guards overwrites", async () => {
    writeFileSync(join(workspace, "payload.bin"), "device bytes\n");
    const pulled = join(hostDir, "pulled.bin");
    const result = await adb({ action: "pull", devicePath: "payload.bin", hostPath: pulled });
    assert.equal(readFileSync(pulled, "utf8"), "device bytes\n");
    assert.equal(result.details.bytes, 13);
    assert.match(text(result), /Pulled .*payload\.bin \(13B\) to .*pulled\.bin/);

    const again = await settle(adb({ action: "pull", devicePath: "payload.bin", hostPath: pulled }));
    assert.equal(again.isError, true, "overwriting a PC file needs an explicit overwrite");
    assert.match(text(again), /overwrite/);
    assert.equal((await settle(adb({ action: "pull", devicePath: "payload.bin", hostPath: pulled, overwrite: true }))).isError, undefined);

    writeFileSync(join(hostDir, "go.txt"), "from the pc\n");
    const pushed = await adb({ action: "push", hostPath: join(hostDir, "go.txt"), devicePath: "incoming.txt" });
    assert.equal(readFileSync(join(workspace, "incoming.txt"), "utf8"), "from the pc\n");
    assert.match(text(pushed), /Pushed .*go\.txt to .*incoming\.txt/);

    const missing = await settle(adb({ action: "push", hostPath: join(hostDir, "nope.txt"), devicePath: "x" }));
    assert.equal(missing.isError, true);
    assert.match(text(missing), /nope\.txt/);
  });

  it("installs APKs and reports failures the way adb really speaks", async () => {
    const apk = join(hostDir, "app.apk");
    writeFileSync(apk, "not really an apk");
    assert.match(text(await adb({ action: "install", hostPath: apk })), /Installed .*app\.apk/);

    process.env.FAKE_ADB_INSTALL_FAILURE = "INSTALL_FAILED_UPDATE_INCOMPATIBLE";
    const conflict = await settle(adb({ action: "install", hostPath: apk }));
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /\[INSTALL_FAILED_UPDATE_INCOMPATIBLE\]/);
    assert.match(text(conflict), /adb never auto-uninstalls/, "the next step is spelled out in the error");
    delete process.env.FAKE_ADB_INSTALL_FAILURE;

    process.env.FAKE_ADB_TRANSFER_ERROR = "failed to copy to /data/local/tmp: No space left on device";
    const transfer = await settle(adb({ action: "install", hostPath: apk }));
    assert.equal(transfer.isError, true);
    assert.match(text(transfer), /No space left on device/);
    assert.match(text(transfer), /adb never auto-uninstalls/, "V26: a copy failure is not a version conflict");
    delete process.env.FAKE_ADB_TRANSFER_ERROR;

    const absent = await settle(adb({ action: "install", hostPath: join(hostDir, "gone.apk") }));
    assert.match(text(absent), /Host APK not found/);
  });

  it("asks before uninstalling and spawns nothing when declined", async () => {
    clearSpawns();
    harness.ui.confirm = false;
    const declined = await adb({ action: "uninstall", packageName: "org.example.app" });
    assert.equal(declined.isError, true);
    assert.match(text(declined), /Uninstall of org\.example\.app was cancelled/);
    assert.deepEqual(spawnLines(), [], "a declined uninstall never spawns adb");

    harness.ui.confirm = true;
    assert.match(text(await adb({ action: "uninstall", packageName: "org.example.app" })), /Uninstalled org\.example\.app/);
    assert.ok(spawnLines().some((line) => line.includes("uninstall") && line.includes("org.example.app")));

    process.env.FAKE_ADB_UNINSTALL_FAILURE = "DELETE_FAILED_INTERNAL_ERROR";
    const failed = await settle(adb({ action: "uninstall", packageName: "org.example.app" }));
    delete process.env.FAKE_ADB_UNINSTALL_FAILURE;
    assert.equal(failed.isError, true);
    assert.match(text(failed), /DELETE_FAILED_INTERNAL_ERROR/);
  });

  it("pairs over stdin so the code never reaches argv or the transcript", async () => {
    clearSpawns();
    harness.ui.input = PAIR_CODE;
    const paired = await adb({ action: "pair", devicePath: "10.0.0.5:37001" });
    harness.ui.input = null;
    assert.match(text(paired), /Paired with 10\.0\.0\.5:37001/);
    assert.equal(readFileSync(join(deviceRoot, ".fake-pair-code"), "utf8"), PAIR_CODE, "adb read the code from stdin");
    const log = spawnLines().join("\n");
    assert.match(log, /pair 10\.0\.0\.5:37001/);
    assert.ok(!log.includes(PAIR_CODE), `the pairing code never appears in argv: ${log}`);
    assert.ok(!text(paired).includes(PAIR_CODE), "the pairing code never appears in the result");
    assert.deepEqual(JSON.stringify(paired.details).includes(PAIR_CODE), false, "nor in the tool details");

    // Measured: `adb pair` exits 0 even when the pairing was rejected.
    harness.ui.input = "00000000";
    const wrong = await adb({ action: "pair", devicePath: "10.0.0.5:37001" });
    harness.ui.input = null;
    assert.equal(wrong.isError, true, "a rejected pairing is reported, not treated as success");
    assert.match(text(wrong), /Wireless pairing failed/);
    assert.match(text(wrong), /wrong pairing code/);

    const cancelled = await adb({ action: "pair", devicePath: "10.0.0.5:37001" });
    assert.match(text(cancelled), /pairing was cancelled/);
    const noTarget = await adb({ action: "pair" });
    assert.match(text(noTarget), /needs the IP:port/);
  });

  it("lists devices with serial, state, model, API level and transport id", async () => {
    const line = text(await adb({ action: "devices" })).split("\n")[0];
    assert.match(line, /adb-05WAY1YE00-E1sWj7\._adb-tls-connect\._tcp\s+device/);
    assert.match(line, /Pixel 3a API 32/);
    assert.match(line, /transport_id=94/);
  });

  it("annotates the endpoint and locates its memory file", async () => {
    assert.match(text(await adb({ action: "note", note: "family pixel" })), /Device note updated \(default device\): family pixel/);
    const config = JSON.parse(readFileSync(join(agentDir, "adb-remote-config.json"), "utf8"));
    assert.equal(config.endpoints.adb.note, "family pixel");
    assert.match(text(await adb({ action: "note" })), /Device note cleared/);

    const memory = await adb({ action: "memory" });
    assert.equal(memory.details.device, "05WAY1YE00");
    assert.match(text(memory), /Use write to create .* with schema \{"device":"05WAY1YE00","entries":\[\]\}/);
  });

  it("reconnects, keeping the device behind the routed tools", async () => {
    const reconnected = await adb({ action: "reconnect" });
    assert.match(text(reconnected), /Reconnected: /);
    assert.equal(reconnected.details.toolRouting, "device");
  });

  it("starts the configured forwards and removes only its own", async () => {
    const forwarded = await adb({ action: "forward" });
    assert.match(text(forwarded), /Forwarded local ports: 19000; tools remain local/);
    assert.equal(forwarded.details.toolRouting, "local", "forwarding alone never captures the file tools");
    assert.match(readFileSync(join(deviceRoot, ".fake-forwards"), "utf8"), /tcp:19000 tcp:8080/);

    const again = await adb({ action: "forward", forwards: "19000:tcp:8080" });
    assert.equal(again.isError, undefined, "re-forwarding our own port is a no-op, not an error");

    process.env.FAKE_ADB_FORWARD_ERROR = "failed to reserve port: 'tcp:19000' already in use";
    const conflict = await settle(adb({ action: "forward", forwards: "19001:tcp:9" }));
    delete process.env.FAKE_ADB_FORWARD_ERROR;
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /Local port 19001 is already forwarded or in use/);
    assert.match(text(conflict), /adb forward --list/, "the error says how to find who owns the port");

    const noMappings = await settle(adb({ action: "forward", forwards: "" }));
    assert.match(text(noMappings), /No port mappings configured/);

    assert.match(text(await adb({ action: "unforward" })), /Removed extension-managed forwards: 19000/);
    assert.match(text(await adb({ action: "unforward" })), /No extension-managed forwards were active/);
  });

  it("disconnects and leaves no routing behind", async () => {
    const disconnected = await adb({ action: "disconnect" });
    assert.match(text(disconnected), /returned to local tools/);
    assert.equal(disconnected.details.toolRouting, "local");
    assert.match(text(await adb({ action: "status" })), /No device is connected/);
  });
});
