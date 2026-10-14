import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AdbTransport,
  buildDeviceCommand,
  METHOD_CLASS,
  parseForwardSpec,
  parseInstallFailure,
  parseStatOutput,
  serializeForwardSpec,
  STAT_COMMAND,
  withDeviceTimeout,
  type AdbTransportMethod,
} from "../src/adb/transport.ts";
import { parseAdbCommand } from "../src/adb/target.ts";

const CAPABILITIES = {
  shellV2: true,
  exitCodes: true,
  stderrSeparation: true,
  hasTimeout: true,
  hasSed: true,
  hasStat: true,
  hasGrep: true,
  hasFind: true,
  uid: "2000",
};

test("device command goldens (plan §5.4)", () => {
  assert.equal(
    buildDeviceCommand("/data/local/tmp", "ls -la", { timeoutSeconds: 30, hasTimeout: true }),
    `cd -- '/data/local/tmp' && timeout -k 5 -s TERM 30 sh -c 'ls -la'`,
  );
  assert.equal(
    buildDeviceCommand("/d/x'y", 'grep -n "a b" f', { timeoutSeconds: 30, hasTimeout: true }),
    `cd -- '/d/x'"'"'y' && timeout -k 5 -s TERM 30 sh -c 'grep -n "a b" f'`,
  );
  // Host shell metacharacters survive as literal device-side characters.
  assert.equal(
    buildDeviceCommand("/d/$HOME/`id`", "echo a'b", { timeoutSeconds: 5, hasTimeout: true }),
    "cd -- '/d/$HOME/`id`' && timeout -k 5 -s TERM 5 sh -c 'echo a'\"'\"'b'",
  );
  assert.equal(
    buildDeviceCommand("/", "pm list packages", { timeoutSeconds: 30, hasTimeout: false }),
    `cd -- '/' && pm list packages`,
  );
  assert.equal(withDeviceTimeout("logcat", 12, false), "logcat");
  assert.equal(withDeviceTimeout("logcat", 12, true), "timeout -k 5 -s TERM 12 sh -c 'logcat'");
});

test("STAT_COMMAND is one spawn, follows symlinks, and reports ABSENT", () => {
  assert.equal(STAT_COMMAND("/data/local/tmp/a b"), `stat -L -c '%F|%a|%s' -- '/data/local/tmp/a b' 2>/dev/null || echo ABSENT`);
});

test("parseStatOutput maps the measured %F vocabulary (V13/V14)", () => {
  assert.deepEqual(parseStatOutput("regular file|666|1\n"), { kind: "file", mode: "666", size: 1 });
  assert.deepEqual(parseStatOutput("regular empty file|666|0"), { kind: "file", mode: "666", size: 0 });
  assert.deepEqual(parseStatOutput("symbolic link|777|30"), { kind: "symlink", mode: "777", size: 30 });
  assert.deepEqual(parseStatOutput("directory|771|3488"), { kind: "dir", mode: "771", size: 3488 });
  assert.deepEqual(parseStatOutput("block special|660|0"), { kind: "other", mode: "660", size: 0 });
  assert.equal(parseStatOutput("ABSENT"), undefined);
  assert.equal(parseStatOutput(""), undefined);
  assert.equal(parseStatOutput("stat: bad output"), undefined);
});

test("parseForwardSpec replaces the SSH L:H:R parser (D7)", () => {
  assert.deepEqual(parseForwardSpec("18080:tcp:8080"), { localPort: 18080, target: "tcp", name: "8080" });
  assert.deepEqual(parseForwardSpec("19222:localabstract:webview_devtools_remote"), {
    localPort: 19222,
    target: "localabstract",
    name: "webview_devtools_remote",
  });
  assert.deepEqual(parseForwardSpec("5000:dev:/dev/socket/x"), { localPort: 5000, target: "dev", name: "/dev/socket/x" });
  assert.deepEqual(parseForwardSpec("1:jdwp:com.x-y:p"), { localPort: 1, target: "jdwp", name: "com.x-y:p" });
  assert.equal(serializeForwardSpec(parseForwardSpec("18080:tcp:8080")), "18080:tcp:8080");
  for (const bad of ["18080", "18080:tcp", "0:tcp:80", "70000:tcp:80", "x:tcp:80", "18080:udp:80", ""]) {
    assert.throws(() => parseForwardSpec(bad), /forward spec|local port/);
  }
});

test("parseInstallFailure reads Failure [CODE: message] (F17)", () => {
  const failure = parseInstallFailure("Performing Streamed Install\nFailure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade verified]");
  assert.ok(failure);
  assert.equal(failure.code, "INSTALL_FAILED_VERSION_DOWNGRADE");
  assert.match(failure.message, /higher versionCode/);
  const bare = parseInstallFailure("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]");
  assert.equal(bare?.code, "INSTALL_FAILED_INSUFFICIENT_STORAGE");
  assert.match(bare?.hint ?? "", /Free space/);
  assert.equal(parseInstallFailure("Success"), undefined);
});

test("METHOD_CLASS covers every public AdbTransport method exactly once (F7)", () => {
  const prototypeMethods = Object.getOwnPropertyNames(AdbTransport.prototype)
    .filter((name) => name !== "constructor" && typeof AdbTransport.prototype[name as AdbTransportMethod] === "function")
    .sort();
  const declared = (Object.keys(METHOD_CLASS) as AdbTransportMethod[]).sort();
  assert.deepEqual(declared, prototypeMethods);
  const readable = declared.filter((name) => METHOD_CLASS[name] === "read");
  assert.deepEqual(readable.sort(), ["listForwards", "readBytes", "readTextRange", "sampleBytes", "screencap", "stat"]);
  const mutating = declared.filter((name) => METHOD_CLASS[name] === "mutate");
  assert.deepEqual(mutating.sort(), [
    "exec",
    "forward",
    "install",
    "pull",
    "push",
    "unforward",
    "uninstall",
    "writeBytes",
  ]);
  for (const name of declared) {
    assert.ok(["read", "mutate"].includes(METHOD_CLASS[name]), name);
  }
});

test("no SSH-era or privileged wrapper survives in src/adb (plan §5.1)", () => {
  for (const file of ["cli.ts", "target.ts", "device.ts", "transport.ts", "mime.ts", "exec-output.ts"]) {
    const source = readFileSync(new URL(`../src/adb/${file}`, import.meta.url), "utf8");
    assert.ok(!/bash -lc/.test(source), `${file}: bash -lc wrapper`);
    assert.ok(!/su 0/.test(source), `${file}: su privilege prefix`);
    assert.ok(!/--kill-after|--signal=/.test(source), `${file}: GNU timeout long options (V8)`);
    assert.ok(!/file --mime-type/.test(source), `${file}: device-side file --mime-type (V10)`);
    assert.ok(!/\bssh\b|\bsftp\b/i.test(source), `${file}: SSH reference`);
  }
});
