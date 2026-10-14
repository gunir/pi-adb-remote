import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseAdbCommand } from "../src/adb/target.ts";
import {
  AdbCommandError,
  capabilitiesCommand,
  classifyAdbError,
  ensureServer,
  getState,
  identityPropsCommand,
  listDevices,
  parseCapabilities,
  parseDevicesOutput,
  parseIdentityProps,
  probeCapabilities,
  readIdentityProps,
  recoveryHint,
  resolveIdentity,
  stripAdbBanner,
  waitForDevice,
  type DeviceEntry,
  type ResolveIdentityDeps,
} from "../src/adb/device.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-adb-device-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The shared stub adb (plan §6 step 5) so steps 4/5 reuse the same fixture.
const fakeAdb = join(dir, "fake-adb.sh");
writeFileSync(fakeAdb, readFileSync(new URL("./fixtures/fake-adb.sh", import.meta.url), "utf8"));
chmodSync(fakeAdb, 0o755);

const root = mkdtempSync(join(dir, "device-root-"));
process.env.ADB = fakeAdb;
process.env.FAKE_ADB_ROOT = root;
after(() => {
  delete process.env.ADB;
  delete process.env.FAKE_ADB_ROOT;
});

const device = parseAdbCommand("adb -i 05WAY1YE00");
const mdnsSerial = "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp";

/** Verbatim capture from the Pixel 3a used for plan §2 (transport_id:94). */
const REAL_DEVICES_OUTPUT = `List of devices attached
${mdnsSerial} device product:sargo model:Pixel_3a device:sargo transport_id:94
`;

test("parseDevicesOutput reads the captured real `adb devices -l` line", () => {
  const entries = parseDevicesOutput(REAL_DEVICES_OUTPUT);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    serial: mdnsSerial,
    state: "device",
    product: "sargo",
    model: "Pixel_3a",
    device: "sargo",
    transportId: "94",
  });
});

test("parseDevicesOutput handles every state shape and skips banners", () => {
  const entries = parseDevicesOutput(
    [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1",
      "0123456789ABCDEF       unauthorized usb:1-2 transport_id:2",
      "10.0.0.9:5555          offline transport_id:3",
      "adb-XYZ-abc._adb-tls-connect._tcp device product:foo model:Foo_Bar device:foo transport_id:4",
      "",
    ].join("\r\n"),
  );
  assert.deepEqual(
    entries.map((entry) => [entry.serial, entry.state]),
    [
      ["emulator-5554", "device"],
      ["0123456789ABCDEF", "unauthorized"],
      ["10.0.0.9:5555", "offline"],
      ["adb-XYZ-abc._adb-tls-connect._tcp", "device"],
    ],
  );
  assert.equal(entries[1].transportId, "2");
  assert.equal(entries[0].model, "sdk_gphone64_x86_64");
});

const CLASSIFICATIONS: [string, string][] = [
  [`adb: device 'BOGUS' not found`, "absent"],
  ["error: no devices/emulators found", "absent"],
  ["error: device offline", "offline"],
  ["error: device unauthorized. This adb server's $ADB_VENDOR_KEYS is not set", "unauthorized"],
  ["adb: more than one device/emulator", "ambiguous"],
  ["adb: error: cannot bind listener: Address already in use", "forward-bind-conflict"],
  ["adb: error: cannot rebind existing socket", "forward-rebind"],
  ["adb server version (41) doesn't match this client (39); killing...", "server-down"],
  ["error: protocol fault (couldn't read status): Connection reset by peer", "server-down"],
  ["cannot connect to daemon: Connection refused", "server-down"],
  // V1/V7: this text comes from the *device shell*, not from adb (F12 handles it separately).
  ["sh: bash: inaccessible or not found", "other"],
  ["Read-only file system", "other"],
];

for (const [text, failure] of CLASSIFICATIONS) {
  test(`classifyAdbError: ${text.slice(0, 44)}`, () => {
    assert.equal(classifyAdbError(text), failure);
  });
}

test("stripAdbBanner removes client banners only", () => {
  const stripped = stripAdbBanner(
    ["* daemon not running; starting now at tcp:5037", "List of devices attached", "serial device"].join("\n"),
  );
  assert.equal(stripped, "List of devices attached\nserial device");
});

function stubDeps(entries: DeviceEntry[], identities: Record<string, string>, probes: number[]): ResolveIdentityDeps {
  return {
    async listDevices() {
      return entries;
    },
    async readIdentityProps(_device, transportSerial, transportId) {
      probes.push(1);
      return {
        identity: identities[transportSerial] ?? `transport:${transportId ?? transportSerial}`,
        props: {},
      };
    },
  };
}

const entry = (serial: string, extra: Partial<DeviceEntry> = {}): DeviceEntry => ({
  serial,
  state: "device",
  ...extra,
});

test("resolveIdentity probes the hint first and resolves a stable identity", async () => {
  const probes: number[] = [];
  const deps = stubDeps([entry(mdnsSerial, { transportId: "94" })], { [mdnsSerial]: "05WAY1YE00" }, probes);
  const resolved = await resolveIdentity(device, mdnsSerial, deps);
  assert.deepEqual(resolved, {
    kind: "resolved",
    transportSerial: mdnsSerial,
    entry: entry(mdnsSerial, { transportId: "94" }),
  });
  assert.equal(probes.length, 1, "one spawn with a single candidate (V28 fast path)");
});

test("resolveIdentity returns absent when the stable identity is not present", async () => {
  const other = "adb-OTHER-xyz._adb-tls-connect._tcp";
  const deps = stubDeps([entry(other)], { [other]: "99OTHER" }, []);
  const resolved = await resolveIdentity(device, undefined, deps);
  assert.equal(resolved.kind, "absent");
});

test("resolveIdentity reports a collision instead of guessing (never auto-switch)", async () => {
  const a = "adb-05WAY1YE00-AAA._adb-tls-connect._tcp";
  const b = "10.0.0.9:5555";
  const deps = stubDeps([entry(a), entry(b)], { [a]: "05WAY1YE00", [b]: "05WAY1YE00" }, []);
  const resolved = await resolveIdentity(device, undefined, deps);
  assert.equal(resolved.kind, "collision");
});

test("resolveIdentity matches a transport serial or transport id directly", async () => {
  const serialDevice = parseAdbCommand("adb -s emulator-5554");
  const bySerial = await resolveIdentity(
    serialDevice,
    undefined,
    stubDeps([entry("emulator-5554"), entry(mdnsSerial)], {}, []),
  );
  assert.deepEqual(bySerial, {
    kind: "resolved",
    transportSerial: "emulator-5554",
    entry: entry("emulator-5554"),
  });

  const idDevice = parseAdbCommand("adb -t 94");
  const byId = await resolveIdentity(
    idDevice,
    undefined,
    stubDeps([entry(mdnsSerial, { transportId: "94" }), entry("emulator-5554", { transportId: "12" })], {}, []),
  );
  assert.equal(byId.kind, "resolved");

  const missing = await resolveIdentity(parseAdbCommand("adb -t 7"), undefined, stubDeps([entry("emulator-5554")], {}, []));
  assert.equal(missing.kind, "absent");
});

test("resolveIdentity never picks a device for an unqualified endpoint", async () => {
  const sole = await resolveIdentity(parseAdbCommand("adb"), undefined, stubDeps([entry("emulator-5554")], {}, []));
  assert.equal(sole.kind, "resolved");

  const two = await resolveIdentity(
    parseAdbCommand("adb"),
    undefined,
    stubDeps([entry("emulator-5554"), entry("0123456789ABCDEF")], {}, []),
  );
  assert.equal(two.kind, "ambiguous");

  const usbPick = await resolveIdentity(
    parseAdbCommand("adb -d"),
    undefined,
    stubDeps([entry("emulator-5554"), entry("0123456789ABCDEF")], {}, []),
  );
  assert.deepEqual(usbPick, { kind: "resolved", transportSerial: "0123456789ABCDEF", entry: entry("0123456789ABCDEF") });
});

test("resolveIdentity ignores non-device transports", async () => {
  const resolved = await resolveIdentity(
    device,
    undefined,
    stubDeps([entry("0123456789ABCDEF", { state: "offline" }), entry("FEDCBA9876543210", { state: "unauthorized" })], {}, []),
  );
  assert.equal(resolved.kind, "absent");
});

test("listDevices, getState and identity props run against the stub adb", async () => {
  const entries = await listDevices(device);
  assert.equal(entries[0].transportId, "94");
  assert.equal(await getState(device, mdnsSerial), "device");

  const identity = await readIdentityProps(device, mdnsSerial, "94");
  assert.equal(identity.identity, "05WAY1YE00");
  assert.deepEqual(identity.props, {
    model: "Pixel 3a",
    product: "sargo",
    apiLevel: "32",
    release: "12",
    abi: "arm64-v8a",
    buildType: "user",
  });
});

test("identity props fall back to ro.boot.serialno then the transport id", async () => {
  const parsed = parseIdentityProps("@identity\n\n@fallbackIdentity\nBOOT123\n");
  assert.equal(parsed.identity, "");
  assert.equal(parsed.fallbackIdentity, "BOOT123");

  process.env.FAKE_ADB_SERIAL = "";
  process.env.FAKE_ADB_BOOT_SERIAL = "BOOT123";
  assert.equal((await readIdentityProps(device, mdnsSerial, "94")).identity, "BOOT123");

  delete process.env.FAKE_ADB_BOOT_SERIAL;
  assert.equal((await readIdentityProps(device, mdnsSerial, "94")).identity, "transport:94");
  delete process.env.FAKE_ADB_SERIAL;
  assert.ok(identityPropsCommand().startsWith('echo "@identity"'));
});

test("probeCapabilities reads applets, uid and shell protocol from one batch", async () => {
  const capabilities = await probeCapabilities(device, mdnsSerial);
  assert.deepEqual(capabilities, {
    shellV2: true,
    exitCodes: true,
    stderrSeparation: true,
    hasTimeout: true,
    hasSed: true,
    hasStat: true,
    hasGrep: true,
    hasFind: true,
    uid: "2000",
  });
  assert.ok(capabilitiesCommand().includes("exit 7"));
});

test("probeCapabilities records shellV2:false when streams are merged (Android <= 10)", () => {
  const merged = parseCapabilities({
    stdout: Buffer.from("@timeout\n/system/bin/timeout\n@stderr\n@exitProbe\n"),
    stderr: Buffer.from(""),
    exitCode: 0,
  });
  assert.equal(merged.shellV2, false);
  assert.equal(merged.exitCodes, false);
  assert.equal(merged.stderrSeparation, false);
  assert.equal(merged.hasTimeout, true);
});

test("ensureServer survives the autostart banner and flags a version mismatch", async () => {
  await ensureServer(device);
  process.env.FAKE_ADB_SERVER_MISMATCH = "adb server version (41) doesn't match this client (39); killing...";
  await assert.rejects(ensureServer(device), (error: unknown) => {
    assert.ok(error instanceof AdbCommandError);
    assert.equal(error.failure, "server-down");
    assert.match(error.message, /adb server mismatch/);
    assert.match(error.message, /align platform-tools or set \$ADB/);
    return true;
  });
  delete process.env.FAKE_ADB_SERVER_MISMATCH;
});

test("waitForDevice is bounded and reports absent on timeout", async () => {
  process.env.FAKE_ADB_WAIT_SECONDS = "3";
  const started = Date.now();
  await assert.rejects(
    waitForDevice(device, mdnsSerial, 0),
    (error: unknown) => {
      assert.ok(error instanceof AdbCommandError);
      assert.equal(error.failure, "absent");
      assert.match(error.message, /Timed out after 0s waiting for/);
      assert.ok(Date.now() - started < 2500, "the local kill bounds the wait");
      return true;
    },
  );
  delete process.env.FAKE_ADB_WAIT_SECONDS;

  await waitForDevice(device, mdnsSerial, 5);
  process.env.FAKE_ADB_WAIT_FAILS = "1";
  await assert.rejects(waitForDevice(device, mdnsSerial, 5), /adb wait-for-device failed/);
  delete process.env.FAKE_ADB_WAIT_FAILS;
});

test("getState classifies a vanished transport as absent", async () => {
  process.env.FAKE_ADB_STATE_FAILS = mdnsSerial;
  assert.equal(await getState(device, "BOGUS"), "absent");
  delete process.env.FAKE_ADB_STATE_FAILS;
});

test("resolveIdentity end to end against the stub adb", async () => {
  const resolved = await resolveIdentity(device, mdnsSerial);
  assert.equal(resolved.kind, "resolved");
});

test("recoveryHint names an action for every failure", () => {
  const failures = [
    "absent",
    "offline",
    "unauthorized",
    "ambiguous",
    "identity-collision",
    "server-down",
    "forward-bind-conflict",
    "forward-rebind",
    "other",
  ] as const;
  for (const failure of failures) {
    const hint = recoveryHint(failure, device);
    assert.ok(hint.length > 20, failure);
    assert.match(hint, /[A-Za-z]/);
  }
  assert.match(recoveryHint("absent", device), /\/adb devices/);
  assert.match(recoveryHint("server-down", device), /\$ADB/);
});
