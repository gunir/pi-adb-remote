import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHarness, text } from "./helpers/extension-harness.ts";

// ---------------------------------------------------------------------------
// `/adb` command, autocomplete and prompt-layer suite (plan §6 step 9).
// Completions are driven through the registered command exactly as Pi asks for
// them; the command body is driven with real argument strings; the prompt
// sections and the device-memory context are driven through their events.
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const SERIAL = "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp";

const root = mkdtempSync(join(tmpdir(), "pi-adb-command-"));
const deviceRoot = join(root, "device");
const workspace = join(deviceRoot, "ws");
const nested = join(workspace, "sub");
const hostDir = join(root, "host");
const agentDir = join(root, "agent");

const fakeAdb = join(root, "fake-adb");
mkdirSync(nested, { recursive: true });
mkdirSync(hostDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
copyFileSync(new URL("./fixtures/fake-adb.sh", import.meta.url), fakeAdb);
chmodSync(fakeAdb, 0o755);

// Private TMPDIR: every scratch directory this process makes is observable and isolated.
const privateTmp = join(root, "tmp");
mkdirSync(privateTmp, { recursive: true });
process.chdir(hostDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TMPDIR = privateTmp;
process.env.ADB = fakeAdb;
process.env.FAKE_ADB_ROOT = deviceRoot;
process.env.FAKE_ADB_PNG = join(root, "screen.png");
process.env.FAKE_ADB_PAIR_CODE = "PAIRCODE123";
writeFileSync(process.env.FAKE_ADB_PNG, PNG_BYTES);

const endpointKeyPlain = "adb";
const endpointKeySerial = `adb -s ${SERIAL}`;
writeFileSync(join(agentDir, "adb-remote-config.json"), `${JSON.stringify({
  activeEndpoint: endpointKeyPlain,
  displayLines: 6,
  endpoints: {
    [endpointKeyPlain]: { adbCommand: "adb", deviceCwd: workspace },
    [endpointKeySerial]: { adbCommand: endpointKeySerial, deviceCwd: workspace, note: "second cable" },
  },
}, null, 2)}\n`);

const harness = createHarness({ cwd: workspace });
const { default: adbRemote } = await import("../index.ts");
adbRemote(harness.api as never);

const completions = (argumentPrefix: string) => harness.commands.get("adb").getArgumentCompletions(argumentPrefix) as { value: string; description?: string }[] | null;
const values = (argumentPrefix: string) => (completions(argumentPrefix) ?? []).map((item) => item.value);
const notify = () => harness.notifications.at(-1)?.text ?? "";
/** Run `/adb <args>` and return the notification the user would have seen. */
async function command(args: string): Promise<string> {
  harness.notifications.length = 0;
  await harness.runCommand("adb", args);
  return notify();
}
const memoryPath = () => join(agentDir, "adb-remote-memories", `${Buffer.from("05WAY1YE00", "utf8").toString("base64url")}.json`);
const config = () => JSON.parse(readFileSync(join(agentDir, "adb-remote-config.json"), "utf8"));

after(() => {
  delete process.env.FAKE_ADB_PNG;
  delete process.env.FAKE_ADB_PAIR_CODE;
  rmSync(root, { recursive: true, force: true });
});

describe("/adb completions", () => {
  it("offers the top-level actions for `/adb `", () => {
    const items = completions("");
    assert.ok(items, "an empty argument prefix still completes");
    for (const wanted of ["devices", "connect", "use", "config", "memory", "forward", "unforward", "exec", "cd", "screen", "pull", "push", "install", "uninstall", "pair", "status", "reconnect", "disconnect"]) {
      assert.ok(items!.some((item) => item.value === wanted), `/adb ${wanted} is offered`);
    }
    assert.ok(!items!.some((item) => ["forget", "remote"].includes(item.value)), "no SSH-era vocabulary");
  });

  it("narrows as the user types and submits a complete token", () => {
    assert.deepEqual(values("conn"), ["connect"]);
    assert.deepEqual(values("conf"), ["config"]);
    assert.equal(completions("status"), null, "a fully typed token is submitted, not completed");
    assert.equal(completions("zzz"), null, "an unknown token offers nothing");
  });

  it("completes `/adb config ` and its value shapes", () => {
    assert.deepEqual(values("config "), [
      "config note", "config cwd", "config forward", "config display-lines",
      "config read-max-lines", "config read-max-bytes", "config exec-max-lines", "config exec-max-bytes",
      "config turn-max-bytes", "config image-max-bytes",
    ]);
    assert.deepEqual(values("config read-max-"), ["config read-max-lines", "config read-max-bytes"]);
    assert.deepEqual(values("config image"), ["config image-max-bytes"]);
    assert.deepEqual(values("config note --"), ["config note --clear"]);
    assert.equal(completions("config display-lines 5"), null, "values are typed by the user");
  });

  it("completes `/adb exec --` flags and stops once the command starts", () => {
    assert.deepEqual(values("exec --"), ["exec --timeout", "exec --lines"]);
    assert.deepEqual(values("exec --l"), ["exec --lines"]);
    assert.equal(completions("exec ls -la"), null, "the device command itself is free-form");
    assert.equal(completions("exec --timeout 5 pid"), null);
  });

  it("completes saved endpoints for `/adb use `", () => {
    const items = completions("use ")!;
    assert.deepEqual(items.map((item) => item.value), [`use ${endpointKeyPlain}`, `use ${endpointKeySerial}`]);
    assert.equal(items[0]?.description, "Active endpoint");
    assert.equal(items[1]?.description, "Saved endpoint");
  });

  it("suppresses file completion inside an /adb argument", async () => {
    await harness.fire("session_start", { reason: "startup" });
    const factory = harness.autocomplete.at(-1) as any;
    assert.ok(factory, "session_start installs the provider");
    let delegated = 0;
    const inner = {
      triggerCharacters: [" "],
      getSuggestions: async () => { delegated += 1; return []; },
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
      shouldTriggerFileCompletion: () => true,
    };
    const provider = factory(inner);
    const ask = async (line: string, col = line.length) => provider.getSuggestions([line], 0, col, {});

    await ask("/adb ");
    assert.equal(delegated, 1, "an argument position asks the inner provider");
    assert.equal(await provider.shouldTriggerFileCompletion(["/adb exec /ht"], 0, 13), true);

    const midWord = await ask("/adb exec ls -la", "/adb exec ls".length);
    assert.equal(midWord, null, "a word under the cursor never triggers a file list");
    await ask("/adb exec ls -la");
    assert.equal(delegated, 2, "the end-of-line case reaches the file completer");
    assert.equal(provider.shouldTriggerFileCompletion(["echo hi"], 0, 7), true, "other commands are untouched");
  });
});

describe("/adb command against the fake device", () => {
  it("connects to the active endpoint when run bare", async () => {
    const output = await command("");
    assert.match(output, /Pixel 3a/, output);
    assert.match(text(await harness.callTool("adb", { action: "status" })), /tool routing: device/);
  });

  it("lists what adb can see", async () => {
    const output = await command("devices");
    assert.match(output, new RegExp(SERIAL));
    assert.match(output, /device/);
    assert.match(output, /transport_id=94/);
  });

  it("canonicalizes a bare serial into `adb -s <serial>` and selects endpoints with use", async () => {
    await command(`connect ${SERIAL}`);
    assert.equal(config().activeEndpoint, endpointKeySerial, "the canonical key was saved and activated");
    assert.match(text(await harness.callTool("adb", { action: "status" })), /transport \S+\)/);

    // Switching to a different command cannot keep controlling the first phone.
    await command(`use ${endpointKeySerial}`);
    assert.match(notify(), /Selected device endpoint/);
    await command(`connect ${endpointKeyPlain}`);
    await command(`use ${endpointKeySerial}`);
    assert.match(notify(), /Selected device endpoint/);
    assert.match(text(await harness.callTool("adb", { action: "status" })), /No device is connected/, "the session let go of the other endpoint");

    await command("use adb");
    assert.match(notify(), /ambiguous/, `adb is a prefix of both keys: ${notify()}`);
    await command("use no-such-endpoint");
    assert.match(notify(), /Endpoint not found/);

    await command(`connect ${endpointKeyPlain}`);
  });

  it("prints and edits the configuration", async () => {
    await command("connect adb");
    const dump = await command("config");
    assert.match(dump, /Device configuration: .*adb-remote-config\.json/);
    assert.match(dump, /Display lines: 6/);
    assert.match(dump, /second cable/, "saved endpoints are listed with their notes");

    assert.match(await command("config note work phone"), /Device note updated/);
    assert.equal(config().endpoints[endpointKeyPlain].note, "work phone");
    assert.match(await command("config note --clear"), /Device note cleared/);
    assert.equal(config().endpoints[endpointKeyPlain].note, undefined);

    assert.match(await command(`config cwd ${nested}`), /Default device directory updated \(default device\)/);
    assert.equal(config().endpoints[endpointKeyPlain].deviceCwd, nested);

    assert.match(await command("config display-lines 9"), /preview updated: 9 lines/);
    assert.equal(config().displayLines, 9);
    assert.match(await command("config display-lines 0"), /(must be|between)/i);
    assert.equal(config().displayLines, 9, "an invalid value is refused and not saved");

    assert.match(await command("config read-max-lines 120"), /120/);
    assert.equal(config().readMaxLines, 120);
    assert.match(await command("config exec-max-bytes 16384"), /16384|16\.0KB/);
    assert.equal(config().execMaxBytes, 16384);
    assert.match(await command("config turn-max-bytes 40000"), /40000|39\.1KB/);
    assert.equal(config().turnMaxBytes, 40000);
    assert.match(await command("config image-max-bytes 2097152"), /2097152|2\.0MB/);
    assert.equal(config().endpoints[endpointKeyPlain].imageMaxBytes, 2097152);

    assert.match(await command("config forward 19002:tcp:9"), /19002/);
    assert.deepEqual(config().endpoints[endpointKeyPlain].forwards, ["19002:tcp:9"]);
  });

  it("moves the device workspace with cd and keeps bare cd on the endpoint", async () => {
    await command(`cd ${workspace}`);
    assert.match(notify(), new RegExp(`Device path: ${workspace}`));

    await command(`cd ${nested}`);
    assert.match(notify(), new RegExp(`Device path: ${nested}`));
    assert.equal(text(await harness.callTool("bash", { command: "pwd" })).trim(), nested);

    await command("cd");
    assert.match(notify(), new RegExp(`Device path: ${nested}`), "bare cd stays on the endpoint workspace, not /data/local/tmp");
  });

  it("runs exec with its own flags", async () => {
    await command(`cd ${workspace}`);
    assert.match(await command("exec -- pwd"), new RegExp(workspace));
    const bounded = await command("exec --lines 3 seq 1 40");
    assert.match(bounded, /Showing last 3 of 40 lines/);
    assert.equal(bounded.trim().split("\n").filter((line) => /^\d+$/.test(line.trim())).length, 3, `preview: ${bounded}`);
    assert.match(await command("exec --timeout 1 sleep 30"), /timed out after 1 seconds/);
    assert.match(await command("exec --lines"), /Expected --lines N, --timeout SECONDS or -- followed by a command/);
  });

  it("captures, moves and installs through the command", async () => {
    const shot = await command("screen cmd-shot.png");
    assert.match(shot, /screen|capture/i, shot);
    const pngPath = join(hostDir, "cmd-shot.png");
    assert.ok(existsSync(pngPath), `${pngPath} was written by /adb screen`);
    assert.equal(readFileSync(pngPath).subarray(1, 4).toString(), "PNG");

    writeFileSync(join(workspace, "payload.bin"), "device bytes\n");
    assert.match(await command(`pull payload.bin ${join(hostDir, "cmd-pulled.bin")}`), /Pulled|pulled/);
    assert.equal(readFileSync(join(hostDir, "cmd-pulled.bin"), "utf8"), "device bytes\n");

    writeFileSync(join(hostDir, "app.apk"), "apk bytes");
    assert.match(await command(`install ${join(hostDir, "app.apk")}`), /Installed|Success/i);

    harness.ui.confirm = true;
    assert.match(await command("uninstall org.example.app"), /Uninstalled|Success/i);
  });

  it("forwards and unforwards the configured mappings", async () => {
    assert.match(await command("forward"), /19002/);
    assert.match(readFileSync(join(deviceRoot, ".fake-forwards"), "utf8"), /tcp:19002/);
    assert.match(await command("unforward"), /19002|Removed/);
  });

  it("pairs a wireless device from the command line", async () => {
    harness.ui.input = "PAIRCODE123";
    assert.match(await command("pair 10.0.0.9:5555"), /Paired|paired/);
    harness.ui.input = null;
    assert.equal(readFileSync(join(deviceRoot, ".fake-pair-code"), "utf8"), "PAIRCODE123");
  });

  it("locates device memory and reports it", async () => {
    const output = await command("memory");
    assert.match(output, /Device memory \(05WAY1YE00\)/);
    assert.ok(existsSync(memoryPath()), "the memory file was created on demand");
    writeFileSync(memoryPath(), `${JSON.stringify({ device: "05WAY1YE00", entries: [{ id: "logs", content: "logcat -d -t 200 is the bounded read" }] }, null, 2)}\n`);
    assert.match(await command("memory"), /bounded read/);
  });

  it("reconnects, reports status and disconnects", async () => {
    assert.match(await command("status"), /Pixel 3a/);
    assert.match(await command("reconnect"), /Reconnected|reconnected/);
    assert.match(await command("status"), /forwarded ports|routing|device/i);
    assert.match(await command("disconnect"), /local|Disconnected/i);
    assert.match(text(await harness.callTool("adb", { action: "status" })), /No device is connected/);
  });

  it("treats an unknown argument as a serial and fails honestly", async () => {
    const output = await command("not-a-real-serial");
    assert.match(output, /not found|absent|failed|error|Connect/i, output);
  });
});

describe("prompt sections and device-memory context", () => {
  before(async () => {
    await harness.runCommand("adb", "connect adb");
  });

  it("adds the three adb_remote_* sections while routing", async () => {
    const options: any = { sections: {} };
    await harness.fire("before_agent_start", { systemPromptOptions: options });
    assert.deepEqual(Object.keys(options.sections).sort(), ["adb_remote_connection", "adb_remote_memory_management", "adb_remote_workspace"]);
    assert.equal(options.cwd, workspace, "the prompt announces the device workspace as cwd");
    const workspacePrompt: string = options.sections.adb_remote_workspace;
    for (const phrase of ["already execute inside this device shell", "adb shell", "toybox/mksh", "no bash, no systemd, no curl", "/system` is read-only", "/sdcard` strips executable", "/data/local/tmp", "logcat -d -t 200", "dumpsys X | head", "tail -n 200", 'adb(action="pull"/"push")']) {
      assert.ok(workspacePrompt.includes(phrase), `the workspace prompt must mention ${phrase}`);
    }
    assert.match(options.sections.adb_remote_memory_management, /always handled by Pi's local read, write, and edit tools/);
    assert.match(options.sections.adb_remote_memory_management, /DELETE SAFETY/);
    assert.match(options.sections.adb_remote_connection, /Pixel 3a/);
  });

  it("injects device memory as a custom context message and replaces the previous one", async () => {
    const injected = await harness.fire("context", {
      messages: [
        { role: "custom", customType: "adb-remote-server-memory", content: "stale", display: false, timestamp: 1 },
        { role: "user", content: "hello" },
      ],
    }) as any;
    assert.equal(injected.messages.length, 2, "the stale copy is replaced, not stacked");
    const custom = injected.messages.filter((message: any) => message.customType === "adb-remote-server-memory");
    assert.equal(custom.length, 1, "exactly one memory message, the newest");
    assert.equal(custom[0].display, false, "the memory note is invisible in the transcript");
    assert.match(custom[0].content, /<adb_remote_device_memory device="05WAY1YE00"/);
    assert.match(custom[0].content, /bounded read/);
    assert.equal(injected.messages[1].content, "hello", "the conversation is preserved");
  });

  it("reports a corrupted memory file instead of applying it", async () => {
    writeFileSync(memoryPath(), "{ not json");
    const injected = await harness.fire("context", { messages: [] }) as any;
    assert.match(injected.messages[0].content, /invalid and must not be applied/);
    writeFileSync(memoryPath(), `${JSON.stringify({ device: "05WAY1YE00", entries: [] }, null, 2)}\n`);
    assert.equal(await harness.fire("context", { messages: [] }), undefined, "no entries means no message");
  });

  it("drops the workspace sections once disconnected", async () => {
    await harness.runCommand("adb", "disconnect");
    const options: any = { sections: {} };
    await harness.fire("before_agent_start", { systemPromptOptions: options });
    assert.deepEqual(Object.keys(options.sections), ["adb_remote_connection"], "the endpoint is still known, the device is not");
    assert.equal(options.cwd, undefined);
  });
});
