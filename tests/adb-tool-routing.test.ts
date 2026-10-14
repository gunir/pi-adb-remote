import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHarness, text } from "./helpers/extension-harness.ts";

// ---------------------------------------------------------------------------
// Tool routing suite (plan §6 step 7). The extension is loaded for real, its
// registered tools are called exactly as the agent calls them, and every `adb`
// invocation lands on the sh-backed fake device. Covers: read ranges, write +
// read round-trip, exact edit, workspace persistence (`cd` vs `adb chdir`, bare
// `cd`), binary refusal, device timeouts, and the ls/grep/find guards.
// ---------------------------------------------------------------------------

const PLAN_FILE = new URL("../ARCHITECTURE_PLAN_adb-remote-transport.md", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "pi-adb-routing-"));
const deviceRoot = join(root, "device");
const workspace = join(deviceRoot, "ws");
const nested = join(workspace, "sub");
const agentDir = join(root, "agent");
const spawnLog = join(root, "spawn.log");

// The extension resolves the adb binary and its config at import time, so the fixture
// environment has to exist first.
const fakeAdb = join(root, "fake-adb");
mkdirSync(nested, { recursive: true });
mkdirSync(agentDir, { recursive: true });
copyFileSync(new URL("./fixtures/fake-adb.sh", import.meta.url), fakeAdb);
chmodSync(fakeAdb, 0o755);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.ADB = fakeAdb;
process.env.FAKE_ADB_ROOT = deviceRoot;
process.env.FAKE_ADB_LOG = spawnLog;
for (const name of ["FAKE_ADB_STATE", "FAKE_ADB_STAT", "FAKE_ADB_SHELL_ERROR", "FAKE_ADB_EXEC_OUT_EMPTY", "FAKE_ADB_TRANSFER_ERROR"]) {
  delete process.env[name];
}
writeFileSync(join(agentDir, "adb-remote-config.json"), `${JSON.stringify({
  activeEndpoint: "adb",
  endpoints: { adb: { adbCommand: "adb", deviceCwd: workspace } },
}, null, 2)}\n`);

const scratchDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pi-adb-remote-output-"));
const leakedBefore = scratchDirs().length;

const harness = createHarness({ cwd: workspace });
const { default: adbRemote } = await import("../index.ts");
adbRemote(harness.api);

after(async () => {
  // The session_shutdown hook is what cleans the spill directory; a run must not leak one.
  await harness.fire("session_shutdown", { reason: "exit" });
  assert.equal(scratchDirs().length, leakedBefore, "session_shutdown removed the scratch directory");
  rmSync(root, { recursive: true, force: true });
});

const deviceFile = (name: string) => join(workspace, name);
const check = (name: string): string => readFileSync(deviceFile(name), "utf8");

describe("adb tool routing against the fake device", () => {
  it("registers the tool surface that SPIKE-4A predicted", () => {
    // §5.8: the guard registrations are only correct if the recorded spike outcome says they are.
    const spike = /SPIKE-4A-RESULT:\s*(ok|readds)/.exec(readFileSync(PLAN_FILE, "utf8"));
    assert.ok(spike, "the plan records a SPIKE-4A outcome");
    const expected = ["adb", "bash", "edit", "read", "write"];
    if (spike![1] === "ok") expected.push("find", "grep", "ls");
    assert.deepEqual([...harness.tools.keys()].sort(), expected.sort());
    assert.ok(harness.commands.has("adb"), "the /adb command is registered");
    assert.ok(!harness.commands.has("remote"), "the legacy remote-host command is gone");
    assert.ok(!harness.commands.has("forget"), "there is no `forget` action any more");
  });

  it("connects to the sole fake device and adopts the endpoint cwd", async () => {
    const result = await harness.callTool("adb", { action: "connect", command: "adb" });
    assert.match(text(result), /Connected: Pixel 3a/);
    assert.match(text(result), new RegExp(workspace));
    assert.ok(harness.statuses.at(-1)?.["adb-remote"], "the status bar shows the device");
  });

  it("spawns adb exactly once per routed command", async () => {
    writeFileSync(spawnLog, "");
    const result = await harness.callTool("bash", { command: "echo one" });
    assert.equal(result.structuredContent?.exit_code, 0, text(result));
    assert.match(text(result), /one/);
    const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(spawns.length, 1, `expected one adb invocation, saw:\n${spawns.join("\n")}`);
  });

  it("reads exactly the requested line range", async () => {
    writeFileSync(deviceFile("range.txt"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const result = await harness.callTool("read", { path: deviceFile("range.txt"), offset: 12, limit: 5 });
    const body = text(result).replace(/\n+\[.*$/s, "");
    assert.equal(body, ["line 12", "line 13", "line 14", "line 15", "line 16"].join("\n"));
    assert.notEqual(result.details?.notExecuted, true);
  });

  it("writes atomically and reads the file back", async () => {
    const target = deviceFile("roundtrip.txt");
    const written = await harness.callTool("write", { path: target, content: "alpha\nbravo\n" });
    assert.equal(written.details?.atomic, true, "staged rename kept the write atomic");
    assert.equal(readFileSync(target, "utf8"), "alpha\nbravo\n");
    assert.equal(text(await harness.callTool("read", { path: target })), "alpha\nbravo\n");
  });

  it("applies the exact edit and leaves the file untouched when it does not match", async () => {
    const target = deviceFile("edit.txt");
    writeFileSync(target, "one\ntwo\nthree\ntwo\n");
    const edited = await harness.callTool("edit", { path: target, edits: [{ oldText: "two\nthree", newText: "2\n3" }] });
    assert.match(text(edited), /Successfully replaced 1 block/);
    assert.equal(check("edit.txt"), "one\n2\n3\ntwo\n");

    const dup = deviceFile("dup.txt");
    writeFileSync(dup, "dup\ndup\n");
    await assert.rejects(
      () => harness.callTool("edit", { path: dup, edits: [{ oldText: "dup", newText: "TWO" }] }),
      /must be unique|Could not find the exact text/i,
      "an ambiguous oldText is refused",
    );
    assert.equal(check("dup.txt"), "dup\ndup\n", "the refused edit wrote nothing");
    assert.equal(check("edit.txt"), "one\n2\n3\ntwo\n", "an unrelated device file was untouched");
  });

  it("keeps `cd` in bash one-shot while adb chdir persists the workspace", async () => {
    const fromCd = await harness.callTool("bash", { command: `cd -- ${nested} && pwd` });
    assert.match(text(fromCd), new RegExp(nested), "the shell really did move");

    const afterCd = await harness.callTool("bash", { command: "pwd" });
    assert.equal(text(afterCd).trim(), workspace, "the session workspace did not follow the shell");

    const chdir = await harness.callTool("adb", { action: "chdir", cwd: nested });
    assert.match(text(chdir), new RegExp(nested));

    const inside = await harness.callTool("bash", { command: "pwd" });
    assert.equal(text(inside).trim(), nested, "adb chdir persisted");

    const config = JSON.parse(readFileSync(join(agentDir, "adb-remote-config.json"), "utf8"));
    assert.equal(config.endpoints.adb.deviceCwd, nested, "the endpoint cwd was persisted for resume");

    // `!cd` in the TUI goes through user_bash: bare cd prints the workspace, never Android's `/`.
    const bare = await harness.fire("user_bash", { command: "cd" });
    assert.equal(bare.result.output, nested, "bare cd reports the endpoint workspace");
    assert.equal(bare.result.exitCode, 0);
    assert.ok(!/^\/$/m.test(bare.result.output), "the workspace is not the root directory (V27)");

    const moved = await harness.fire("user_bash", { command: `cd ${workspace}` });
    assert.equal(moved.result.output, workspace);
    const backInside = await harness.callTool("bash", { command: "pwd" });
    assert.equal(text(backInside).trim(), workspace, "user-bash cd persisted the workspace");
  });

  it("refuses to read a device binary as text", async () => {
    const target = deviceFile("binary.bin");
    writeFileSync(target, Buffer.concat([Buffer.from("#!head\n"), Buffer.from([0, 1, 2, 0, 255, 0])]));
    await assert.rejects(
      () => harness.callTool("read", { path: target }),
      (error: Error) => {
        assert.match(error.message, /Refusing to read device binary file as text \([^)]+\)/);
        assert.match(error.message, /binary\.bin/);
        return true;
      },
    );
  });

  it("maps a device timeout onto the bash result", async () => {
    const started = Date.now();
    await assert.rejects(
      () => harness.callTool("bash", { command: "sleep 30", timeout: 1 }),
      /Command timed out after 1 seconds/,
      "the device `timeout` wrapper is reported as a timeout, not a crash",
    );
    assert.ok(Date.now() - started < 15_000, "the device timeout ended the command, not the host grace period");
    const after = await harness.callTool("bash", { command: "wc -l < range.txt" });
    assert.match(text(after), /50/, "the session survived the timeout");
  });

  it("guards ls, grep and find while routing is active", async () => {
    for (const name of ["ls", "grep", "find"]) {
      await assert.rejects(
        () => harness.callTool(name, name === "grep" ? { pattern: "alpha" } : { path: workspace }),
        /cannot be routed to the device/,
        `${name} must refuse rather than silently return host results`,
      );
    }
  });

  it("keeps device-memory JSON on the PC while routing is active", async () => {
    const memory = await harness.callTool("adb", { action: "memory" });
    const path = memory.details?.path as string;
    assert.ok(path?.endsWith(".json"), `memory action reports its file: ${path}`);
    assert.ok(existsSync(path), "the memory file was created");
    assert.match(text(memory), /05WAY1YE00/);

    const payload = `${JSON.stringify({ device: "05WAY1YE00", entries: [{ id: "logs", content: "logcat lives in /dev/log" }] }, null, 2)}\n`;
    await harness.callTool("write", { path, content: payload });
    assert.equal(readFileSync(path, "utf8"), payload, "write updates the host-side memory file");
    assert.ok(!existsSync(join(deviceFile(path.replace(/\//g, "-")))), "nothing was created on the device");

    await harness.callTool("edit", { path, edits: [{ oldText: "/dev/log", newText: "/proc/last_kmsg" }] });
    assert.match(readFileSync(path, "utf8"), /proc\/last_kmsg/, "edit updates the memory file too");
  });

  it("disconnects and hands the tools back to the PC", async () => {
    const disconnected = await harness.callTool("adb", { action: "disconnect" });
    assert.match(text(disconnected), /local/);

    const local = await harness.callTool("bash", { command: "echo host-side" });
    assert.match(text(local), /host-side/);
    assert.equal(local.structuredContent?.exit_code, 0);

    const listed = await harness.callTool("ls", { path: root });
    assert.match(text(listed), /device/, "ls delegates to the host again");
  });
});
