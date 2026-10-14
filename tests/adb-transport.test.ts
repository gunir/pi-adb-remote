import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, afterEach, beforeEach, describe, it } from "node:test";
import { classifyAdbError, type DeviceCapabilities } from "../src/adb/device.ts";
import { parseAdbCommand } from "../src/adb/target.ts";
import { AdbTransport, InstallFailure, parseForwardSpec } from "../src/adb/transport.ts";

// ---------------------------------------------------------------------------
// Offline round-trip suite (plan §6 step 5). `$ADB` points at the sh-backed fake
// device, so every transport method runs end to end with no device attached:
// real `sh`, real `stat`, real `cp`, real `timeout`, real files. Device paths are
// host paths under a temp directory so the emulated shell can reach them.
// ---------------------------------------------------------------------------

const CAPS: DeviceCapabilities = {
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

const root = mkdtempSync(join(tmpdir(), "pi-adb-roundtrip-"));
const deviceRoot = join(root, "device");
const workspace = join(deviceRoot, "data", "local", "tmp");
const scratch = join(root, "scratch");

function makeTransport(caps: DeviceCapabilities = CAPS): AdbTransport {
  return new AdbTransport(parseAdbCommand("adb"), "05WAY1YE00", caps, { imageMaxBytes: 8 * 1024 * 1024, spillCapBytes: 1024 * 1024 }, scratch);
}

before(() => {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const fake = join(root, "fake-adb.sh");
  copyFileSync(new URL("./fixtures/fake-adb.sh", import.meta.url), fake);
  chmodSync(fake, 0o755);
  process.env.ADB = fake;
  process.env.FAKE_ADB_ROOT = deviceRoot;
  process.env.FAKE_ADB_LOG = join(root, "spawn.log");
  delete process.env.FAKE_ADB_STAT;
  delete process.env.FAKE_ADB_STATE;
  delete process.env.FAKE_ADB_FORWARD_ERROR;
  delete process.env.FAKE_ADB_TRANSFER_ERROR;
  delete process.env.FAKE_ADB_INSTALL_FAILURE;
  delete process.env.FAKE_ADB_INSTALL_STREAM;
  delete process.env.FAKE_ADB_SHELL_ERROR;
  delete process.env.FAKE_ADB_EXEC_OUT_EMPTY;
  rmSync(process.env.FAKE_ADB_LOG as string, { force: true });
});

after(() => rmSync(root, { recursive: true, force: true }));

const md5 = (data: Buffer) => createHash("md5").update(data).digest("hex");

// Each test owns its device behaviour: clear every override before and after it runs, so one
// failing assertion cannot leak a state change into the next test.
const OVERRIDES = [
  "FAKE_ADB_STAT",
  "FAKE_ADB_STATE",
  "FAKE_ADB_FORWARD_ERROR",
  "FAKE_ADB_TRANSFER_ERROR",
  "FAKE_ADB_INSTALL_FAILURE",
  "FAKE_ADB_INSTALL_STREAM",
  "FAKE_ADB_UNINSTALL_FAILURE",
  "FAKE_ADB_SHELL_ERROR",
  "FAKE_ADB_EXEC_OUT_EMPTY",
  "FAKE_ADB_FORWARDS",
] as const;

beforeEach(() => {
  for (const name of OVERRIDES) delete process.env[name];
  rmSync(process.env.FAKE_ADB_LOG as string, { force: true });
});

afterEach(() => {
  for (const name of OVERRIDES) delete process.env[name];
});

/** Lines the fake adb logged since the last reset (spawn counting, V1). */
function spawnLog(): string[] {
  const file = process.env.FAKE_ADB_LOG as string;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

describe("stat: the %F vocabulary and its failure modes", () => {
  const t = makeTransport();

  it("maps directories, regular files and symlinks", async () => {
    writeFileSync(join(workspace, "f.txt"), "hello\nworld\n");
    chmodSync(join(workspace, "f.txt"), 0o644);
    const dirInfo = await t.stat(workspace);
    assert.equal(dirInfo!.kind, "dir");
    assert.equal(dirInfo!.mode, (statSync(workspace).mode & 0o777).toString(8), "mode reads as the octal chmod form");
    assert.equal(dirInfo!.size, (await t.stat(workspace))!.size);
    assert.deepEqual(await t.stat(join(workspace, "f.txt")), { kind: "file", mode: "644", size: 12 });
    await t.exec(`ln -s f.txt link`, workspace, { timeoutSeconds: 10 });
    // `stat -L` follows links (V14), so a link reports the target's facts.
    assert.equal((await t.stat(join(workspace, "link")))!.kind, "file");
  });

  it("returns undefined for absent paths, including the literal ABSENT marker (V3)", async () => {
    assert.equal(await t.stat(join(workspace, "nope")), undefined);
    process.env.FAKE_ADB_STAT = "ABSENT";
    assert.equal(await t.stat(join(workspace, "f.txt")), undefined);
    process.env.FAKE_ADB_STAT = "no such file or directory";
    assert.equal(await t.stat(join(workspace, "f.txt")), undefined);
    delete process.env.FAKE_ADB_STAT;
  });

  it("classifies non-file types as other instead of guessing (V13)", async () => {
    process.env.FAKE_ADB_STAT = "symbolic link|777|10";
    assert.deepEqual(await t.stat(join(workspace, "x")), { kind: "symlink", mode: "777", size: 10 });
    process.env.FAKE_ADB_STAT = "special file|600|0";
    assert.equal((await t.stat(join(workspace, "x")))!.kind, "other");
    process.env.FAKE_ADB_STAT = "regular empty file|644|0";
    assert.equal((await t.stat(join(workspace, "x")))!.kind, "file");
    delete process.env.FAKE_ADB_STAT;
  });

  it("returns undefined for output outside the vocabulary (V3)", async () => {
    process.env.FAKE_ADB_STAT = "Permission denied";
    assert.equal(await t.stat(join(workspace, "f.txt")), undefined);
    // An unrecognised type word still means "something is there" — it is never guessed to be a
    // regular file, which is what keeps the read/write paths from treating it as one.
    process.env.FAKE_ADB_STAT = "weird|777|1";
    assert.deepEqual(await t.stat(join(workspace, "f.txt")), { kind: "other", mode: "777", size: 1 });
    delete process.env.FAKE_ADB_STAT;
  });

  it("surfaces transport failures rather than silently reporting absence", async () => {
    process.env.FAKE_ADB_SHELL_ERROR = "adb: device offline";
    await assert.rejects(() => t.stat(join(workspace, "f.txt")), /offline/i);
  });
});

describe("read paths are gated by stat and byte-exact", () => {
  const t = makeTransport();
  const text = join(workspace, "bytes.txt");
  const payload = Buffer.concat([
    Buffer.from("line one\r\n", "utf8"),
    Buffer.from("héllo wörld — 日本語\n", "utf8"),
    Buffer.from("no trailing newline", "utf8"),
  ]);

  before(() => writeFileSync(text, payload));

  it("readBytes reproduces CRLF, UTF-8 and a missing trailing newline bit-for-bit (V22)", async () => {
    const got = await t.readBytes(text, 1024);
    assert.equal(md5(got), md5(payload));
    assert.equal(got.toString("utf8"), payload.toString("utf8"));
  });

  it("readTextRange returns whole lines and never past EOF (V23)", async () => {
    const first = await t.readTextRange(text, 1, 1, 1024);
    assert.equal(first.toString("utf8"), "line one\r\n");
    const tail = await t.readTextRange(text, 3, 99, 1024);
    assert.equal(tail.toString("utf8"), "no trailing newline");
    // A range past EOF is an empty read, not a truncation (no `sed` "primary input discarded").
    const past = await t.readTextRange(text, 9, 9, 1024);
    assert.equal(past.length, 0);
    assert.ok(!past.toString("utf8").includes("sed"));
  });

  it("caps the transfer instead of pulling a huge file (F4)", async () => {
    await assert.rejects(() => t.readBytes(text, 8), /above the .* byte cap/i);
    // `readTextRange` truncates at `head -c maxBytes` by contract (§5.4); the caller sees a short
    // read rather than an error, which is how the read tool reports truncation.
    const slice = await t.readTextRange(text, 1, 99, 4);
    assert.ok(slice.length <= 4 && slice.length > 0);
    assert.equal((await t.readBytes(text, 1024)).length, payload.length);
  });

  it("refuses directories, absent paths and empty files with an honest error (F3/V34)", async () => {
    await assert.rejects(() => t.readBytes(workspace, 1024), /is a directory/);
    await assert.rejects(() => t.readTextRange(workspace, 1, 2, 1024), /is a directory/);
    await assert.rejects(() => t.readBytes(join(workspace, "gone"), 10), /No such device file/);
    const empty = join(workspace, "empty.bin");
    writeFileSync(empty, Buffer.alloc(0));
    assert.equal((await t.readBytes(empty, 1024)).length, 0);
    assert.equal((await t.readTextRange(empty, 1, 1, 1024)).length, 0);
    assert.equal((await t.sampleBytes(empty, 512)).length, 0);
    // A non-empty file whose exec-out returns nothing is a transport fault, not an empty file (V34).
    process.env.FAKE_ADB_EXEC_OUT_EMPTY = "1";
    await assert.rejects(() => t.readBytes(text, 1024), /no bytes|SELinux/i);
    process.env.FAKE_ADB_SHELL_ERROR = "adb: device offline";
    await assert.rejects(() => t.readBytes(text, 1024), /offline/i);
  });

  it("sampleBytes returns the head without a full read", async () => {
    assert.equal((await t.sampleBytes(text, 9)).toString("utf8"), "line one\r");
  });

  it("spawns once per device command, never once per line (V1)", async () => {
    const many = join(workspace, "many.txt");
    writeFileSync(many, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n");
    await t.readTextRange(many, 1, 200, 1 << 20);
    const lines = spawnLog();
    assert.equal(lines.length, 2, lines.join("\n")); // stat gate + the read itself
  });
});

describe("exec: composition, streams and failure signals", () => {
  const t = makeTransport();

  it("applies cwd, propagates exit codes and captures stdout when not streaming", async () => {
    const result = await t.exec(`printf '%s\\n' hi && pwd`, workspace, { timeoutSeconds: 15 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.notExecuted, false);
    // Regression guard: a non-streaming caller must receive the accumulated stdout.
    assert.equal(result.stdout.toString("utf8"), `hi\n${workspace}\n`);
  });

  it("survives host-side shell metacharacters and device-side quoting", async () => {
    const quoted = await t.exec(`printf '%s' 'it'"'"'s'`, workspace, { timeoutSeconds: 15 });
    assert.equal(quoted.stdout.toString("utf8"), "it's");
    const literal = await t.exec(`printf '%s' '$HOME'`, workspace, { timeoutSeconds: 15 });
    assert.equal(literal.stdout.toString("utf8"), "$HOME");
  });

  it("propagates a non-zero device exit code as data, not as an error", async () => {
    const result = await t.exec(`echo boom >&2; exit 42`, workspace, { timeoutSeconds: 15 });
    assert.equal(result.exitCode, 42);
    assert.equal(result.stderr.toString("utf8").trim(), "boom");
  });

  it("reports device-side timeouts as rc 124, not as a host kill (V4)", async () => {
    const result = await t.exec(`sleep 5`, workspace, { timeoutSeconds: 1 });
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, false);
  });

  it("streams to the caller and returns an empty stdout (F24)", async () => {
    const chunks: Buffer[] = [];
    const result = await t.exec(`printf 'abc'; printf 'def'`, workspace, {
      timeoutSeconds: 15,
      onStdout: (c) => chunks.push(c),
    });
    assert.equal(result.stdout.length, 0);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "abcdef");
    assert.equal(result.notExecuted, false);
  });

  it("marks a command that produced nothing before being cut short", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await t.exec(`printf 'never'`, workspace, { timeoutSeconds: 15, signal: controller.signal });
    assert.equal(aborted.notExecuted, true);
  });
});

describe("writeBytes: staging, mode preservation and cleanup", () => {
  const t = makeTransport();

  it("creates a 0644 file through the staging path", async () => {
    const target = join(workspace, "new.txt");
    assert.deepEqual(await t.writeBytes(target, Buffer.from("one\ntwo\n")), { atomic: true });
    assert.equal(readFileSync(target, "utf8"), "one\ntwo\n");
    assert.equal((await t.stat(target))!.mode, "644");
  });

  it("preserves the mode of an existing file (F9)", async () => {
    const target = join(workspace, "keep-mode.sh");
    writeFileSync(target, "#!/system/bin/sh\necho old\n");
    chmodSync(target, 0o750);
    await t.writeBytes(target, Buffer.from("#!/system/bin/sh\necho new\n"));
    assert.equal(readFileSync(target, "utf8"), "#!/system/bin/sh\necho new\n");
    assert.equal((await t.stat(target))!.mode, "750");
    assert.equal(statSync(target).mode & 0o777, 0o750);
  });

  it("leaves no staging directory or scratch files behind (F13)", async () => {
    const dir = join(workspace, "clean");
    mkdirSync(dir, { recursive: true });
    await t.writeBytes(join(dir, "a.txt"), Buffer.from("a"));
    await t.writeBytes(join(dir, "a.txt"), Buffer.from("b"));
    const entries = await t.exec(`find . -name '.pi-staging' -o -name 'w-*'`, dir, { timeoutSeconds: 10 });
    assert.equal(entries.stdout.toString("utf8").trim(), "");
    assert.deepEqual(await t.exec(`test ! -e .pi-staging && pwd`, dir, { timeoutSeconds: 10 }).then((r) => r.exitCode), 0);
  });

  it("garbage-collects files a previous run left in staging (F14)", async () => {
    const dir = join(workspace, "gc");
    mkdirSync(join(dir, ".pi-staging"), { recursive: true });
    const orphan = join(dir, ".pi-staging", "w-old.txt");
    writeFileSync(orphan, "abandoned");
    // Only stale scratch files are collected: a fresh one may belong to a concurrent write.
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(orphan, stale, stale);
    await t.writeBytes(join(dir, "x.txt"), Buffer.from("fresh"));
    assert.equal(existsSync(orphan), false);
    assert.equal(readFileSync(join(dir, "x.txt"), "utf8"), "fresh");
  });

  it("writes THROUGH a symlink instead of replacing it (F16)", async () => {
    const dir = join(workspace, "links");
    mkdirSync(dir, { recursive: true });
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "original\n");
    await t.exec(`ln -sf real.txt link.txt`, dir, { timeoutSeconds: 10 });
    await t.writeBytes(link, Buffer.from("through\n", "utf8"));
    const info = await t.exec(`ls -l link.txt`, dir, { timeoutSeconds: 10 });
    assert.match(info.stdout.toString("utf8"), /^lrwxrwxrwx/, "the link must still be a link");
    assert.equal(readFileSync(real, "utf8"), "through\n");
  });

  it("falls back to the non-atomic path and says so when staging is impossible (F15)", async () => {
    const dir = join(workspace, "ro");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "file.txt");
    writeFileSync(target, "old\n");
    chmodSync(target, 0o666);
    chmodSync(dir, 0o500); // r-x for the owner: no new entries, but the existing file stays writable
    const result = await t.writeBytes(target, Buffer.from("fallback\n"));
    assert.deepEqual(result, { atomic: false });
    assert.equal(readFileSync(target, "utf8"), "fallback\n");
    chmodSync(dir, 0o755);
  });

  it("refuses to overwrite a directory and keeps it intact", async () => {
    const dir = join(workspace, "as-dir");
    mkdirSync(dir, { recursive: true });
    await assert.rejects(() => t.writeBytes(dir, Buffer.from("nope")), /is a directory|not a regular file/);
    assert.ok(statSync(dir).isDirectory());
  });

  it("keeps the write error when cleanup also fails (F13)", async () => {
    // A directory that cannot be entered: staging fails and `cat >` fails too.
    const dir = join(workspace, "locked");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    await assert.rejects(
      () => t.writeBytes(join(dir, "x.txt"), Buffer.from("data")),
      /could not write|Permission denied|failed/i,
    );
    chmodSync(dir, 0o755);
  });
});

describe("push and pull", () => {
  const t = makeTransport();

  it("round-trips bytes through the device path", async () => {
    const host = join(root, "host.bin");
    const blob = Buffer.alloc(4096);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 7) & 0xff;
    writeFileSync(host, blob);
    await t.push(host, join(workspace, "pushed.bin"));
    assert.equal(md5(readFileSync(join(workspace, "pushed.bin"))), md5(blob));
    const out = join(root, "pulled.bin");
    await t.pull(join(workspace, "pushed.bin"), out);
    assert.equal(md5(readFileSync(out)), md5(blob));
  });

  it("applies push's directory and overwrite rules", async () => {
    const host = join(root, "apk.bin");
    writeFileSync(host, "apk-bytes");
    const dir = join(workspace, "into");
    mkdirSync(dir, { recursive: true });
    await assert.rejects(() => t.push(host, dir), /is a directory — end the device path with '\/'/);
    await t.push(host, `${dir}/`);
    assert.equal(readFileSync(join(dir, "apk.bin"), "utf8"), "apk-bytes");
    await assert.rejects(() => t.push(host, join(dir, "apk.bin")), /already exists .* overwrite: true|Refusing to overwrite existing host file/);
    await t.push(host, join(dir, "apk.bin"), { overwrite: true });
    await assert.rejects(() => t.push(join(root, "missing.bin"), join(workspace, "x")), /Host file not found/);
  });

  it("reports a transfer-level failure with the line that proves it (V27, F28)", async () => {
    const host = join(root, "ok.bin");
    writeFileSync(host, "payload");
    process.env.FAKE_ADB_TRANSFER_ERROR = "[  0%] /data/local/tmp/x: cannot create";
    await assert.rejects(() => t.push(host, join(workspace, "err.bin")), (error: Error) => {
      assert.match(error.message, /cannot create/);
      assert.ok(!/exit 1$/.test(error.message), "the transfer line must be the payload, not a bare exit code");
      return true;
    });
    const source = join(workspace, "pushed.bin");
    process.env.FAKE_ADB_TRANSFER_ERROR = "Permission denied";
    await assert.rejects(() => t.pull(source, join(root, "err.out")), /Permission denied/);
    delete process.env.FAKE_ADB_TRANSFER_ERROR;
    await t.pull(source, join(root, "err.out"));
  });

  it("refuses to pull onto an existing host file without overwrite", async () => {
    const fresh = join(root, "fresh.bin");
    await t.pull(join(workspace, "pushed.bin"), fresh);
    await assert.rejects(() => t.pull(join(workspace, "pushed.bin"), fresh), /already exists .* overwrite: true|Refusing to overwrite existing host file/);
    await t.pull(join(workspace, "pushed.bin"), fresh, { overwrite: true });
    await assert.rejects(() => t.pull(join(workspace, "nope.bin"), join(root, "never.bin")), /No such device file/);
  });
});

describe("forward, unforward and listForwards", () => {
  const t = makeTransport();

  it("forwards typed specs and lists only this transport's entries", async () => {
    await t.forward(parseForwardSpec("8100:tcp:5037"));
    await t.forward(parseForwardSpec("8101:localabstract:devtools"));
    const entries = await t.listForwards();
    assert.deepEqual(entries, [
      { localPort: 8100, target: "tcp", name: "5037" },
      { localPort: 8101, target: "localabstract", name: "devtools" },
    ]);
    await t.unforward(8100);
    assert.deepEqual(await t.listForwards(), [{ localPort: 8101, target: "localabstract", name: "devtools" }]);
  });

  it("parses and serializes the spec grammar without touching adb (V7)", () => {
    assert.deepEqual(parseForwardSpec("18080:tcp:8080"), { localPort: 18080, target: "tcp", name: "8080" });
    assert.deepEqual(parseForwardSpec("9222:jdwp:abc"), { localPort: 9222, target: "jdwp", name: "abc" });
    for (const value of ["", "tcp:8100", "8100", "8100:tcp:", "0:tcp:80", "70000:tcp:80", "8100:resmgr:x", "8100:host:foo", "8100:tcp:a b"]) {
      assert.throws(() => parseForwardSpec(value), /invalid/i, value);
    }
  });

  it("distinguishes a busy port from a broken server (V24, V25, F27)", async () => {
    process.env.FAKE_ADB_FORWARD_ERROR = "failed to reserve port: address already in use";
    await assert.rejects(() => t.forward(parseForwardSpec("8101:tcp:5037")), (error: Error) => {
      assert.match(error.message, /address already in use/);
      assert.match(error.message, /forward-bind-conflict|forward-rebind/, "the conflict class must be named (F27)");
      assert.equal(classifyAdbError(error.message.includes("address already in use") ? "address already in use" : ""), "forward-bind-conflict");
      return true;
    });
    process.env.FAKE_ADB_FORWARD_ERROR = "protocol fault (couldn't read status): Connection reset by peer";
    await assert.rejects(() => t.forward(parseForwardSpec("8101:tcp:5037")), (error: Error) => {
      assert.match(error.message, /protocol fault/);
      assert.ok(!/bind-conflict|rebind/.test(error.message), "a protocol fault must not be reported as a port conflict");
      assert.equal(classifyAdbError("error: protocol fault (couldn't read status)"), "server-down");
      return true;
    });
    delete process.env.FAKE_ADB_FORWARD_ERROR;
  });

  it("reports a duplicate local port the way adb does (V24)", async () => {
    rmSync(join(deviceRoot, ".fake-forwards"), { force: true });
    await t.forward(parseForwardSpec("8110:tcp:5037"));
    await assert.rejects(() => t.forward(parseForwardSpec("8110:tcp:9229")), /address already in use/);
    rmSync(join(deviceRoot, ".fake-forwards"), { force: true });
  });
});

describe("install and uninstall", () => {
  const t = makeTransport();
  const apk = join(root, "app.apk");
  before(() => writeFileSync(apk, "not-really-an-apk"));

  it("succeeds on `Success`", async () => {
    await t.install(apk);
    await t.install(apk, { timeoutSeconds: 20 });
  });

  it("maps every Failure [CODE] shape to a typed error with a hint (V21, V28, V29, V30)", async () => {
    for (const [code, hintPattern] of [
      ["INSTALL_FAILED_UPDATE_INCOMPATIBLE", /uninstall/i],
      ["INSTALL_FAILED_VERSION_DOWNGRADE", /downgrade/i],
      ["INSTALL_FAILED_ABORTED", /dialog|user/i],
      ["INSTALL_FAILED_INSUFFICIENT_STORAGE", /space/i],
      ["INSTALL_FAILED_CUSTOM_CODE", /code|insufficient|unrecognised|unrecogni|unknown/i],
    ] as const) {
      process.env.FAKE_ADB_INSTALL_FAILURE = code;
      await assert.rejects(
        () => t.install(apk),
        (error: Error) => {
          assert.ok(error instanceof InstallFailure, `${code} must map to InstallFailure, got ${error.constructor.name}`);
          assert.equal((error as InstallFailure).code, code);
          assert.match(error.message, hintPattern);
          assert.match(error.message, new RegExp(code));
          return true;
        },
        code,
      );
    }
    delete process.env.FAKE_ADB_INSTALL_FAILURE;
  });

  it("catches the streaming failure lines that carry no bracket (V21)", async () => {
    process.env.FAKE_ADB_INSTALL_STREAM = "dir";
    await assert.rejects(() => t.install(apk), /couldn.t be created|Could not access/);
    process.env.FAKE_ADB_INSTALL_STREAM = "space";
    await assert.rejects(() => t.install(apk), /No space left on device/);
    delete process.env.FAKE_ADB_INSTALL_STREAM;
  });

  it("surfaces a path that never reaches the package manager (V26)", async () => {
    process.env.FAKE_ADB_TRANSFER_ERROR = "failed to copy 'app.apk': remote couldn't create file";
    await assert.rejects(() => t.install(apk), /failed to copy|failed to commit/);
    delete process.env.FAKE_ADB_TRANSFER_ERROR;
  });

  it("refuses an APK that does not exist on the host", async () => {
    await assert.rejects(() => t.install(join(root, "gone.apk")), /Host APK not found/);
  });

  it("uninstalls and reports a failure honestly (V21, F23)", async () => {
    await t.uninstall("com.example.app");
    await assert.rejects(() => t.uninstall("not a package!"), /Invalid package name/);
    process.env.FAKE_ADB_UNINSTALL_FAILURE = "DELETE_FAILED_INTERNAL_ERROR";
    await assert.rejects(() => t.uninstall("com.example.app"), /DELETE_FAILED_INTERNAL_ERROR|Failure/);
    delete process.env.FAKE_ADB_UNINSTALL_FAILURE;
  });
});

describe("capability fallbacks change the composed command", () => {
  it("drops the timeout wrapper when the device has no `timeout` (V5)", async () => {
    const t = makeTransport({ ...CAPS, hasTimeout: false });
    const result = await t.exec(`printf '%s' bare`, workspace, { timeoutSeconds: 10 });
    assert.equal(result.stdout.toString("utf8"), "bare");
    await t.exec(`printf '%s' bare`, workspace, { timeoutSeconds: 10 });
    const logged = spawnLog().join("\n");
    assert.ok(!logged.includes("timeout -k"), logged);
    assert.match(logged, /&& printf/);
  });

  it("keeps the wrapper when `timeout` is present", async () => {
    const t = makeTransport();
    await t.exec(`printf '%s' wrapped`, workspace, { timeoutSeconds: 10 });
    assert.match(spawnLog().join("\n"), /timeout -k 5 -s TERM 10 sh -c/);
  });
});

describe("transport hygiene", () => {
  it("never uses bash, `su 0` or a host shell (V1, V6, F30)", async () => {
    const t = makeTransport();
    rmSync(join(deviceRoot, ".fake-forwards"), { force: true });
    await t.stat(workspace);
    await t.readBytes(join(workspace, "f.txt"), 64);
    await t.writeBytes(join(workspace, "hygiene.txt"), Buffer.from("x"));
    await t.exec(`printf '%s' done`, workspace, { timeoutSeconds: 10 });
    await t.forward(parseForwardSpec("8123:tcp:1"));
    const logged = spawnLog().join("\n");
    assert.ok(!/bash/.test(logged), logged);
    assert.ok(!/\bsu 0\b/.test(logged), logged);
    assert.ok(!/--kill-after|--signal=/u.test(logged), "GNU-only timeout options must never reach the device");
    assert.ok(!/file --mime-type/.test(logged), "MIME detection is host-side (F5)");
    assert.ok(/shell -T -e none/.test(logged), logged);
  });

  it("lists only this transport's forwards (V24)", async () => {
    rmSync(join(deviceRoot, ".fake-forwards"), { force: true });
    const ours = makeTransport();
    // A row belonging to a different transport is someone else's forward.
    process.env.FAKE_ADB_FORWARDS = "999999 tcp:8123 tcp:1\n05WAY1YE00 tcp:8124 tcp:2";
    assert.deepEqual(await ours.listForwards(), [{ localPort: 8124, target: "tcp", name: "2" }]);
    rmSync(join(deviceRoot, ".fake-forwards"), { force: true });
  });
});
