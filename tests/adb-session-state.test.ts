import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHarness, text } from "./helpers/extension-harness.ts";

// ---------------------------------------------------------------------------
// Connection state-machine and session-restore suite (plan §4.2, F6/F9/F25/F29).
// Drives the fake device through the states a real phone hits: the `offline`
// window right after a replug, a locked or unauthorized device, a device that
// vanished, a device that lost a toybox applet between reconnects, and the
// session entries a reloaded Pi process has to re-attach from.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "pi-adb-session-"));
const deviceRoot = join(root, "device");
const workspace = join(deviceRoot, "ws");
const agentDir = join(root, "agent");
const forwardsFile = join(deviceRoot, ".fake-forwards");

const fakeAdb = join(root, "fake-adb");
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
copyFileSync(new URL("./fixtures/fake-adb.sh", import.meta.url), fakeAdb);
chmodSync(fakeAdb, 0o755);

const privateTmp = join(root, "tmp");
mkdirSync(privateTmp, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TMPDIR = privateTmp;
process.env.ADB = fakeAdb;
process.env.FAKE_ADB_ROOT = deviceRoot;

const DEFAULT_DEVICES = "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp device product:sargo model:Pixel_3a device:sargo transport_id:94";
process.env.FAKE_ADB_DEVICES = DEFAULT_DEVICES;
writeFileSync(join(agentDir, "adb-remote-config.json"), `${JSON.stringify({
  activeEndpoint: "adb",
  endpoints: { adb: { adbCommand: "adb", deviceCwd: workspace } },
}, null, 2)}\n`);

const harness = createHarness({ cwd: workspace });
const { default: adbRemote } = await import("../index.ts");
adbRemote(harness.api as never);

const TRANSIENT_VARS = ["FAKE_ADB_STATE", "FAKE_ADB_STATE_TRANSIENT", "FAKE_ADB_DEVICES", "FAKE_ADB_MISSING_APPLETS"];
function setEnv(vars: Record<string, string | undefined>): void {
  for (const name of TRANSIENT_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(join(deviceRoot, ".fake-state-reads"), { force: true });
}
const statusText = async () => text(await harness.callTool("adb", { action: "status" }));
async function connect(): Promise<{ result: any; notes: string }> {
  harness.notifications.length = 0;
  const result = await harness.callTool("adb", { action: "connect", command: "adb" });
  return { result, notes: harness.notifications.map((entry) => entry.text).join("\n") };
}
async function disconnect(): Promise<void> {
  await harness.callTool("adb", { action: "disconnect" });
}

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("connection state machine", () => {
  it("settles the transient `offline` window after a replug instead of failing (F25)", async () => {
    setEnv({ FAKE_ADB_STATE: "offline", FAKE_ADB_STATE_TRANSIENT: "2" });
    const started = Date.now();
    const { result, notes } = await connect();
    assert.match(text(result), /Connected: Pixel 3a/, notes);
    assert.ok(Date.now() - started >= 500, "the settle loop polled the device state");
    assert.match(await statusText(), /tool routing: device/);
    await disconnect();
  });

  it("gives up on a device that stays offline and says what to do (F25)", async () => {
    setEnv({ FAKE_ADB_STATE: "offline" });
    const started = Date.now();
    const { result } = await connect();
    assert.equal(result.isError, true);
    assert.match(text(result), /offline/i);
    assert.match(text(result), /device|adb devices|replug|unlock/i, "a recovery hint accompanies the failure");
    assert.ok(Date.now() - started >= 4_000, "the transient window was exhausted, not skipped");
    assert.match(await statusText(), /No device is connected/, "a failed connect leaves nothing half-built");
  });

  it("names an unauthorized device without waiting for it to appear", async () => {
    setEnv({ FAKE_ADB_STATE: "unauthorized" });
    const { result } = await connect();
    assert.equal(result.isError, true);
    assert.match(text(result), /unauthorize/i);
    assert.match(text(result), /unlock|authorize|allow/i, "the user is told to accept the prompt on the phone");
  });

  it("refuses to guess when the endpoint's device is gone (F9)", async () => {
    setEnv({ FAKE_ADB_STATE: "device", FAKE_ADB_DEVICES: "emulator-5554        offline product:gvm model:sdk_gphone device:gvm transport_id:7" });
    const { result } = await connect();
    assert.equal(result.isError, true, "an attached-but-offline device is not adopted as a substitute");
    assert.match(text(result), /adb sees|no devices|offline/i);
    setEnv({});
  });

  it("warns when a reconnect changes the device capabilities (F6)", async () => {
    setEnv({});
    await connect();
    assert.match(text(await harness.callTool("adb", { action: "exec", deviceCommand: "echo ok" })), /ok/);

    setEnv({ FAKE_ADB_MISSING_APPLETS: "timeout" });
    harness.notifications.length = 0;
    const reconnected = await harness.callTool("adb", { action: "reconnect" });
    assert.match(text(reconnected), /Reconnected/);
    assert.match(harness.notifications.map((entry) => entry.text).join("\n"), /capabilities changed after reconnect.*hasTimeout: true -> false/);
    assert.equal(reconnected.details.toolRouting, "device", "routing survives the re-probe");

    setEnv({});
    harness.notifications.length = 0;
    await harness.callTool("adb", { action: "reconnect" });
    assert.match(harness.notifications.map((entry) => entry.text).join("\n"), /hasTimeout: false -> true/);
    await disconnect();
  });
});

describe("session restore", () => {
  const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-adb-remote-state", data });

  it("re-attaches a saved session and re-routes the tools", async () => {
    setEnv({});
    await disconnect();
    harness.entries = [entry({ version: 2, connected: true, identity: "05WAY1YE00", command: "adb", cwd: workspace, routeDeviceTools: true, forwards: [] })];
    await harness.fire("session_start", { reason: "reload" });
    assert.match(await statusText(), /Connected: Pixel 3a/);
    assert.equal(text(await harness.callTool("bash", { command: "pwd" })).trim(), workspace);
    harness.entries = [];
  });

  it("restores forwards but skips a port another process already owns", async () => {
    // Another process (or tool) already forwarded this port for this very device.
    writeFileSync(forwardsFile, `adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp tcp:19005 tcp:8080\n`);
    await disconnect();
    harness.entries = [entry({
      version: 2, connected: true, identity: "05WAY1YE00", command: "adb", cwd: workspace, routeDeviceTools: true,
      forwards: ["19005:tcp:8080", "19006:tcp:8081"],
    })];
    harness.notifications.length = 0;
    await harness.fire("session_start", { reason: "reload" });
    const notes = harness.notifications.map((n) => n.text).join("\n");
    assert.match(notes, /Skipped restored forwards already owned by another process: 19005:tcp:8080/);
    const rows = readFileSync(forwardsFile, "utf8").split("\n").filter(Boolean);
    assert.equal(rows.filter((row) => row.includes("tcp:19005")).length, 1, "the owned port was left exactly as another process left it");
    assert.ok(rows.some((row) => row.includes("tcp:19006")), "the free port was restored");
    await harness.callTool("adb", { action: "unforward" });
    await disconnect();
    harness.entries = [];
    rmSync(forwardsFile, { force: true });
  });

  it("refuses to continue on a different phone than the session was saved for (F29)", async () => {
    setEnv({});
    await disconnect();
    harness.entries = [entry({ version: 2, connected: true, identity: "05OTHER9999", command: "adb", cwd: workspace, routeDeviceTools: true, forwards: [] })];
    harness.notifications.length = 0;
    await harness.fire("session_start", { reason: "reload" });
    const notes = harness.notifications.map((n) => n.text).join("\n");
    assert.match(notes, /Device session restore failed/);
    assert.match(notes, /refusing to continue on the wrong phone/);
    assert.match(await statusText(), /No device is connected/);
    harness.entries = [];
  });

  it("ignores pre-conversion and foreign entries instead of misapplying them (F29)", async () => {
    await disconnect();
    harness.entries = [entry({ version: 1, connected: true, host: "build-host", remoteCwd: "~/repo" })];
    await harness.fire("session_start", { reason: "reload" });
    assert.match(await statusText(), /No device is connected/);

    harness.entries = [entry({ version: 3, connected: true, identity: "05WAY1YE00", command: "adb" })];
    await harness.fire("session_start", { reason: "reload" });
    assert.match(await statusText(), /No device is connected/, "an unknown future version is not guessed at");

    harness.entries = [{ type: "custom", customType: "something-else", data: { version: 2, connected: true } }];
    await harness.fire("session_start", { reason: "reload" });
    assert.match(await statusText(), /No device is connected/);
    harness.entries = [];
  });

  it("carries the live connection across an in-process reload", async () => {
    setEnv({});
    await disconnect();
    await connect();
    await harness.fire("session_shutdown", { reason: "reload" });
    assert.match(await statusText(), /No device is connected/, "shutdown released the device");
    harness.entries = [];
    await harness.fire("session_start", { reason: "reload" });
    assert.match(await statusText(), /Connected: Pixel 3a/, "the new session inherited the runtime connection");
    await disconnect();
    await harness.fire("session_start", { reason: "reload" });
    assert.match(await statusText(), /No device is connected/, "a plain exit does not leave a resumable connection");
  });

  it("removes the session scratch directory only on a real exit", async () => {
    const scratchNames = () => readdirSync(privateTmp).filter((name) => name.startsWith("pi-adb-remote-"));
    await connect();
    const active = scratchNames();
    assert.equal(active.length, 1, `one scratch directory per live session: ${active.join(",")}`);
    await harness.fire("session_shutdown", { reason: "reload" });
    assert.deepEqual(scratchNames(), active, "a reload keeps the spill directory");
    await harness.fire("session_start", { reason: "reload" });
    await harness.fire("session_shutdown", { reason: "exit" });
    assert.deepEqual(scratchNames(), [], "the exit removed it");
  });
});
