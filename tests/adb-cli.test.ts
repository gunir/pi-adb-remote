import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  AdbNotInstalledError,
  CommandTooLongError,
  MAX_DEVICE_COMMAND_BYTES,
  MAX_DEVICE_COMMAND_BYTES_WIN32,
  execOutArgv,
  resolveAdbBinary,
  runAdb,
  shellArgv,
  subcommandArgv,
} from "../src/adb/cli.ts";
import { parseAdbCommand } from "../src/adb/target.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-adb-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function sdkWith(exe: string): string {
  const home = mkdtempSync(join(dir, "sdk-"));
  mkdirSync(join(home, "platform-tools"), { recursive: true });
  writeFileSync(join(home, "platform-tools", exe), "#!/bin/sh\n");
  return home;
}

const argsScript = fixture("args.sh", 'echo "argc=$#"; for a in "$@"; do echo "arg<${a}>"; done');
const codesScript = fixture("codes.sh", "echo stdout-line; echo stderr-line 1>&2; exit 42");
const streamScript = fixture(
  "stream.sh",
  'i=0; while [ $i -lt 4000 ]; do echo "line-$i-padding-padding-padding"; i=$((i+1)); done',
);
const sleepScript = fixture("sleep.sh", "sleep 30");
const catScript = fixture("cat.sh", "cat");

// runAdb resolves the binary from process.env.ADB on every call.
function useAdb(path: string): void {
  process.env.ADB = path;
}
useAdb(argsScript);
after(() => {
  delete process.env.ADB;
});

const mdnsDevice = parseAdbCommand("adb -s adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp");

test("resolveAdbBinary prefers $ADB over SDK and PATH", () => {
  const home = sdkWith("adb");
  const binary = resolveAdbBinary({ ADB: argsScript, ANDROID_HOME: home, PATH: home }, "linux");
  assert.deepEqual(binary, { path: argsScript, source: "env" });
});

test("resolveAdbBinary falls back to ANDROID_HOME, then PATH", () => {
  const home = sdkWith("adb");
  assert.deepEqual(resolveAdbBinary({ ANDROID_HOME: home, PATH: join(dir, "no-path") }, "linux"), {
    path: join(home, "platform-tools", "adb"),
    source: "sdk",
  });

  const pathDir = mkdtempSync(join(dir, "path-"));
  writeFileSync(join(pathDir, "adb"), "#!/bin/sh\n");
  assert.deepEqual(resolveAdbBinary({ PATH: `${join(dir, "empty")}:${pathDir}` }, "linux"), {
    path: join(pathDir, "adb"),
    source: "path",
  });
});

test("resolveAdbBinary looks for adb.exe on win32", () => {
  const home = sdkWith("adb.exe");
  assert.deepEqual(resolveAdbBinary({ ANDROID_HOME: home, PATH: home }, "win32"), {
    path: join(home, "platform-tools", "adb.exe"),
    source: "sdk",
  });
});

test("resolveAdbBinary throws AdbNotInstalledError listing every candidate", () => {
  assert.throws(
    () =>
      resolveAdbBinary(
        { ADB: join(dir, "nope", "adb"), ANDROID_HOME: join(dir, "no-sdk"), PATH: join(dir, "no-path") },
        "linux",
      ),
    (error: unknown) => {
      assert.ok(error instanceof AdbNotInstalledError);
      assert.match(error.message, /install Android platform-tools or set \$ADB/);
      assert.ok(error.candidates.includes(join(dir, "nope", "adb")));
      assert.ok(error.candidates.includes(join(dir, "no-sdk", "platform-tools", "adb")));
      assert.ok(error.candidates.includes(join(dir, "no-path", "adb")));
      return true;
    },
  );
});

test("shellArgv uses the verified exec flag set and drops -n when stdin is piped", () => {
  assert.deepEqual(
    shellArgv(mdnsDevice, "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp", "ls -la", { stdin: false }),
    ["-s", "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp", "shell", "-T", "-e", "none", "-n", "ls -la"],
  );
  assert.ok(!shellArgv(mdnsDevice, "serial", "cat f", { stdin: true }).includes("-n"));
});

test("execOutArgv and subcommandArgv keep the resolved transport serial", () => {
  const device = parseAdbCommand("adb -H build-host -P 5038 -d");
  assert.deepEqual(execOutArgv(device, "emulator-5554", "head -c 4 f"), [
    "-H",
    "build-host",
    "-P",
    "5038",
    "-s",
    "emulator-5554",
    "exec-out",
    "head -c 4 f",
  ]);
  assert.deepEqual(subcommandArgv(device, undefined, ["forward", "--list"]), [
    "-H",
    "build-host",
    "-P",
    "5038",
    "-d",
    "forward",
    "--list",
  ]);
});

test("runAdb passes argv verbatim without a host shell", async () => {
  const result = await runAdb(["shell", "-T", "-e", "none", "-n", "echo hi; echo pwned"], {
    timeoutSeconds: 10,
    maxCaptureBytes: 65536,
  });
  assert.equal(result.exitCode, 0);
  const text = result.stdout.toString();
  assert.match(text, /argc=6/);
  assert.match(text, /arg<echo hi; echo pwned>/);
  assert.ok(!text.includes("pwned\n"), "host shell must not interpret the command payload");
});

test("runAdb reports exit code and separated stderr", async () => {
  useAdb(codesScript);
  const result = await runAdb(["shell", "x"], { timeoutSeconds: 10, maxCaptureBytes: 65536 });
  assert.equal(result.exitCode, 42);
  assert.equal(result.stdout.toString(), "stdout-line\n");
  assert.equal(result.stderr.toString(), "stderr-line\n");
  useAdb(argsScript);
});

test("runAdb enforces maxCaptureBytes by killing the child and keeping the tail", async () => {
  useAdb(streamScript);
  const result = await runAdb(["shell", "flood"], { timeoutSeconds: 30, maxCaptureBytes: 1024 });
  assert.equal(result.capHit, true);
  assert.equal(result.exitCode, null, "child must be killed at the cap");
  assert.ok(result.stdout.length <= 1024);
  const text = result.stdout.toString();
  assert.ok(!text.includes("line-0-"), "head is dropped");
  assert.match(text, /line-\d+-padding/, "tail is kept");
  useAdb(argsScript);
});

test("runAdb kills the child at timeout and reports timedOut", async () => {
  useAdb(sleepScript);
  const started = Date.now();
  const result = await runAdb(["shell", "sleep"], { timeoutSeconds: 0, graceSeconds: 0, maxCaptureBytes: 4096 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 5000);
  useAdb(argsScript);
});

test("runAdb aborts on signal", async () => {
  useAdb(sleepScript);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await runAdb(["shell", "sleep"], {
    timeoutSeconds: 30,
    maxCaptureBytes: 4096,
    signal: controller.signal,
  });
  assert.equal(result.aborted, true);
  useAdb(argsScript);
});

test("runAdb pipes stdin byte-exactly", async () => {
  useAdb(catScript);
  const payload = Buffer.from([0x61, 0x00, 0xff, 0x62, 0x0d, 0x0a]);
  const result = await runAdb(["shell", "cat"], { timeoutSeconds: 10, maxCaptureBytes: 4096, stdin: payload });
  assert.equal(result.exitCode, 0);
  assert.deepEqual([...result.stdout], [...payload]);
  useAdb(argsScript);
});

test("runAdb streams to onStdout and returns an empty buffer", async () => {
  useAdb(streamScript);
  let streamed = 0;
  const result = await runAdb(["shell", "flood"], {
    timeoutSeconds: 30,
    maxCaptureBytes: 65536,
    onStdout: (chunk) => {
      streamed += chunk.length;
    },
  });
  assert.ok(streamed > 1024, "stream consumer sees data");
  assert.equal(result.stdout.length, 0);
  assert.equal(result.capHit, false);
  useAdb(argsScript);
});

test("runAdb never spawns through a host shell", () => {
  const source = readFileSync(new URL("../src/adb/cli.ts", import.meta.url), "utf8");
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /shell:\s*true/);
});

test("runAdb rejects an argv above the host limit before spawning", async () => {
  await assert.rejects(
    runAdb(["shell", "x".repeat(MAX_DEVICE_COMMAND_BYTES + 1024)], { timeoutSeconds: 5, maxCaptureBytes: 1024 }),
    (error: unknown) => {
      assert.ok(error instanceof CommandTooLongError);
      assert.equal(error.limit, MAX_DEVICE_COMMAND_BYTES);
      return true;
    },
  );
  await assert.rejects(
    runAdb(["shell", "x".repeat(30000)], { timeoutSeconds: 5, maxCaptureBytes: 1024 }, "win32"),
    (error: unknown) => {
      assert.ok(error instanceof CommandTooLongError);
      assert.equal(error.limit, MAX_DEVICE_COMMAND_BYTES_WIN32);
      return true;
    },
  );
});
