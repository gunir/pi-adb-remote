import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHarness, text } from "../helpers/extension-harness.ts";

// ---------------------------------------------------------------------------
// Live device suite (plan §6 step 7). Runs against a real attached phone with the
// real `adb`. Enable with `PI_ADB_LIVE=1 npm run test:live`; the suite skips
// itself when no device is attached so CI stays green without hardware.
//
// Everything happens under a private directory in /data/local/tmp, and the
// session's config and memory live in a throwaway agent directory, so a run
// leaves neither files nor configuration behind.
// ---------------------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "pi-adb-live-"));
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
delete process.env.ADB;
delete process.env.FAKE_ADB_ROOT;

function attachedDevice(): string | undefined {
  try {
    const out = execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 15_000 });
    const attached = /^\S+\s+device(\s|$)/m.exec(out);
    return attached?.[0]?.trim().split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

const serial = attachedDevice();
const skipReason = process.env.PI_ADB_LIVE !== "1" ? "set PI_ADB_LIVE=1 to run live device tests" : serial ? false : "no adb device attached";

const harness = createHarness();
if (!skipReason) {
  const { default: adbRemote } = await import("../../index.ts");
  adbRemote(harness.api as never);
}

const DEVICE_DIR = `/data/local/tmp/pi-adb-live-${process.pid}`;
const call = (name: string, params: any) => harness.callTool(name, params);

after(async () => {
  if (skipReason) return;
  // The last test disconnects, so cleanup has to go through `adb`, not the (now local) bash tool.
  await call("adb", { action: "exec", deviceCommand: `rm -rf ${DEVICE_DIR}` }).catch(() => undefined);
  await harness.fire("session_shutdown", { reason: "exit" }).catch(() => undefined);
  await call("adb", { action: "disconnect" }).catch(() => undefined);
  rmSync(sandbox, { recursive: true, force: true });
});

describe("adb tool routing on a real device", { skip: skipReason }, () => {
  let workspace = DEVICE_DIR;

  it("connects to the attached phone", async () => {
    const result = await call("adb", { action: "connect", command: "adb" });
    assert.match(text(result), /Connected: /);
    const status = await call("adb", { action: "status" });
    assert.match(text(status), /transport \S+\)/, "status names the transport serial it resolved");
    const devices = await call("adb", { action: "devices" });
    assert.match(text(devices), new RegExp(serial as string), "the attached serial is listed");
  });

  it("creates its private workspace and keeps it as the session cwd", async () => {
    const created = await call("bash", { command: `mkdir -p ${DEVICE_DIR}` });
    assert.equal(created.structuredContent?.exit_code, 0, text(created));
    const chdir = await call("adb", { action: "chdir", cwd: DEVICE_DIR });
    assert.match(text(chdir), new RegExp(DEVICE_DIR));
    const inside = await call("bash", { command: "pwd" });
    assert.equal(text(inside).trim(), DEVICE_DIR);
    workspace = DEVICE_DIR;
  });

  it("reads exactly the requested line range", async () => {
    await call("write", { path: `${workspace}/range.txt`, content: Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join("\n") + "\n" });
    const result = await call("read", { path: `${workspace}/range.txt`, offset: 8, limit: 4 });
    assert.equal(text(result).replace(/\n+\[.*$/s, ""), ["row 8", "row 9", "row 10", "row 11"].join("\n"));
  });

  it("writes, reads back, and edits the same bytes", async () => {
    const target = `${workspace}/notes.txt`;
    const written = await call("write", { path: target, content: "alpha\nbravo\n" });
    assert.equal(written.details?.atomic, true, "the staged rename stayed atomic on this device");
    assert.equal(text(await call("read", { path: target })), "alpha\nbravo\n");

    const edited = await call("edit", { path: target, edits: [{ oldText: "bravo", newText: "charlie" }] });
    assert.match(text(edited), /Successfully replaced 1 block/);
    const digest = await call("bash", { command: `md5sum ${target}` });
    assert.match(text(digest), /^[0-9a-f]{32}/);

    // Writes create their parent directory, which is how a session drops files into a fresh tree.
    const nestedWrite = await call("write", { path: `${workspace}/nested/dir/deep.txt`, content: "deep\n" });
    assert.equal(nestedWrite.details?.atomic, true, text(nestedWrite));
    assert.equal(text(await call("read", { path: `${workspace}/nested/dir/deep.txt` })), "deep\n");
  });

  it("keeps `cd` one-shot while adb chdir persists the workspace", async () => {
    const moved = await call("bash", { command: "cd /system && pwd" });
    assert.match(text(moved), /\/system/);
    assert.equal(text(await call("bash", { command: "pwd" })).trim(), workspace, "the session did not follow the shell");

    const chdir = await call("adb", { action: "chdir", cwd: "/system" });
    assert.match(text(chdir), /\/system/);
    assert.equal(text(await call("bash", { command: "pwd" })).trim(), "/system");

    // Bare `cd` means "the workspace I am in", never Android's `/` (V27).
    const viaUserBash = await harness.fire("user_bash", { command: "cd" });
    assert.equal(viaUserBash?.result?.output, "/system", "!cd with no argument reports the workspace");
    assert.equal(viaUserBash?.result?.exitCode, 0);
    await call("adb", { action: "chdir", cwd: workspace });
    assert.equal(text(await call("bash", { command: "pwd" })).trim(), workspace);
  });

  it("refuses to read a device binary as text", async () => {
    await call("bash", { command: `dd if=/system/bin/logcat of=${workspace}/binary bs=4096 count=8 2>/dev/null || cp /system/bin/logcat ${workspace}/binary` });
    await assert.rejects(
      () => call("read", { path: `${workspace}/binary` }),
      (error: Error) => {
        assert.match(error.message, /Refusing to read device binary file as text/);
        return true;
      },
    );
  });

  it("returns a screenshot as an image block", async () => {
    await call("bash", { command: `screencap -p ${workspace}/shot.png` });
    const result = await call("read", { path: `${workspace}/shot.png` });
    const image = (result.content ?? []).find((block: any) => block.type === "image");
    assert.ok(image, `expected an image block, got: ${text(result).slice(0, 120)}`);
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").subarray(1, 4).toString(), "PNG");
  });

  it("captures the screen onto the PC and as an image block", async () => {
    const hostPath = join(sandbox, "capture.png");
    const result = await call("adb", { action: "screen", hostPath });
    const image = (result.content ?? []).find((block: any) => block.type === "image");
    assert.ok(image, `expected an image block, got: ${text(result).slice(0, 120)}`);
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").subarray(1, 4).toString(), "PNG");
    assert.equal(existsSync(hostPath), true, `the capture was written to ${hostPath}`);
    const onDisk = readFileSync(hostPath);
    assert.equal(onDisk.subarray(1, 4).toString(), "PNG");
    assert.equal(onDisk.length, result.details.bytes, "the reported size is what landed on disk");
  });

  it("reports a device timeout instead of a crash", async () => {
    await assert.rejects(() => call("bash", { command: "sleep 30", timeout: 2 }), /Command timed out after 2 seconds/);
    assert.equal((await call("bash", { command: "echo alive" })).structuredContent?.exit_code, 0, "the session survived");
  });

  it("reports a rejected wireless pairing instead of its exit code", async () => {
    // Measured (V36): `adb pair` reads the code from stdin and exits 0 even when it fails, so the
    // extension must judge the text. 127.0.0.1:5555 is not a pairing endpoint.
    harness.ui.input = "ABCDEF123456";
    const paired = await call("adb", { action: "pair", devicePath: "127.0.0.1:5555" });
    harness.ui.input = null;
    assert.equal(paired.isError, true, text(paired));
    assert.match(text(paired), /Wireless pairing failed/);
    assert.ok(!text(paired).includes("ABCDEF123456"), "the code is never echoed back");
  });

  it("disconnects and returns the tools to the PC", async () => {
    const disconnected = await call("adb", { action: "disconnect" });
    assert.match(text(disconnected), /local/);
    const local = await call("bash", { command: "echo host-side" });
    assert.match(text(local), /host-side/);
    assert.ok(!text(local).includes("/data/local/tmp"), "the command really ran on the PC");
  });
});
