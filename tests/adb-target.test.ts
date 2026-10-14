import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalCommand,
  deviceArgs,
  endpointKey,
  parseAdbCommand,
  parseWirelessTarget,
  type ParsedDevice,
} from "../src/adb/target.ts";

/** The accepted grammar of plan §5.2, as `input -> expectations`. */
const FORMS: [string, (device: ParsedDevice) => void][] = [
  [
    "adb",
    (d) => {
      assert.deepEqual(d.selector, { kind: "sole" });
      assert.equal(d.command, "adb");
    },
  ],
  [
    "adb shell",
    (d) => {
      assert.deepEqual(d.selector, { kind: "sole" });
      assert.equal(d.command, "adb");
    },
  ],
  [
    "192.168.1.5:5555",
    (d) => {
      assert.deepEqual(d.selector, { kind: "serial", serial: "192.168.1.5:5555" });
      assert.equal(d.command, "adb -s 192.168.1.5:5555");
    },
  ],
  [
    "adb -s emulator-5554 shell",
    (d) => {
      assert.deepEqual(d.selector, { kind: "serial", serial: "emulator-5554" });
      assert.equal(d.command, "adb -s emulator-5554");
    },
  ],
  [
    "adb -t 94",
    (d) => {
      assert.deepEqual(d.selector, { kind: "transportId", transportId: "94" });
      assert.equal(d.command, "adb -t 94");
    },
  ],
  [
    "adb -d",
    (d) => {
      assert.deepEqual(d.selector, { kind: "pick", pick: "usb" });
      assert.equal(d.command, "adb -d");
      assert.equal(d.label, "USB device");
    },
  ],
  [
    "adb -e",
    (d) => {
      assert.deepEqual(d.selector, { kind: "pick", pick: "tcp" });
      assert.equal(d.command, "adb -e");
    },
  ],
  [
    "adb -H build-host -P 5038 -s emulator-5554",
    (d) => {
      assert.deepEqual(d.selector, { kind: "serial", serial: "emulator-5554" });
      assert.equal(d.serverHost, "build-host");
      assert.equal(d.serverPort, 5038);
      assert.equal(d.command, "adb -H build-host -P 5038 -s emulator-5554");
    },
  ],
  [
    "adb connect phone.local",
    (d) => {
      assert.deepEqual(d.wirelessTarget, { host: "phone.local", port: 5555 });
      assert.deepEqual(d.selector, { kind: "serial", serial: "phone.local:5555" });
      assert.equal(d.command, "adb connect phone.local:5555");
    },
  ],
  [
    "adb connect 10.0.0.9:5556",
    (d) => {
      assert.deepEqual(d.wirelessTarget, { host: "10.0.0.9", port: 5556 });
      assert.equal(d.command, "adb connect 10.0.0.9:5556");
    },
  ],
  [
    "adb -i 05WAY1YE00",
    (d) => {
      assert.deepEqual(d.selector, { kind: "identity", identity: "05WAY1YE00" });
      assert.equal(d.command, "adb -i 05WAY1YE00");
      assert.equal(endpointKey(d), "adb -i 05WAY1YE00");
    },
  ],
  [
    "adb -H lab-server -i 05WAY1YE00",
    (d) => {
      assert.equal(d.serverPort, 5037);
      assert.equal(d.command, "adb -H lab-server -P 5037 -i 05WAY1YE00");
      assert.deepEqual(deviceArgs(d, "serial-1"), ["-H", "lab-server", "-P", "5037", "-s", "serial-1"]);
    },
  ],
];

for (const [input, check] of FORMS) {
  test(`parseAdbCommand: ${input}`, () => {
    check(parseAdbCommand(input));
  });
}

const REJECTS: [string, RegExp][] = [
  ["", /empty command/],
  ["adb -x", /unknown flag -x/],
  ["adb --serial abc", /unknown flag --serial/],
  ["adb -s", /-s requires a serial/],
  ["adb foo bar", /two positionals/],
  ["adb -P 5037", /-P requires -H/],
  ["adb -P 0 -H h", /invalid server port 0/],
  ["adb -P 65536 -H h", /invalid server port 65536/],
  ["adb connect h:0", /invalid wireless port 0/],
  ["adb pair 10.0.0.9:5555", /one-shot pairing helper/],
  ["adb pair", /pair requires/],
  ["adb connect", /connect requires/],
  ["adb -d -e", /only one of/],
  ["adb -s abc -t 3", /only one of/],
  ["adb -t notanumber", /invalid transport id/],
  ["adb -i 'bad token'", /invalid identity/],
  ["adb -i ../evil", /invalid identity/],
  ["adb shell emulator-5554", /cannot be combined with a positional/],
];

for (const [input, pattern] of REJECTS) {
  test(`parseAdbCommand rejects: ${input || "(empty)"}`, () => {
    assert.throws(() => parseAdbCommand(input), (error: unknown) => {
      assert.match((error as Error).message, pattern);
      // Every rejection names the supported grammar.
      assert.match((error as Error).message, /Supported forms: adb \| adb shell/);
      return true;
    });
  });
}

test("parse(canonical(p)) deep-equals p", () => {
  for (const [input] of FORMS) {
    const parsed = parseAdbCommand(input);
    assert.deepEqual(parseAdbCommand(parsed.command), parsed, `round trip of ${input}`);
    assert.deepEqual(parseAdbCommand(parseAdbCommand(parsed.command).command), parsed);
  }
});

test("canonicalCommand builds the persisted key", () => {
  assert.equal(canonicalCommand({}), "adb");
  assert.equal(canonicalCommand({ sole: true }), "adb");
  assert.equal(canonicalCommand({ identity: "05WAY1YE00" }), "adb -i 05WAY1YE00");
  assert.equal(canonicalCommand({ pick: "usb" }), "adb -d");
  assert.equal(canonicalCommand({ transportId: "94" }), "adb -t 94");
  assert.equal(
    canonicalCommand({ serverHost: "host", serverPort: 5037, identity: "05WAY1YE00" }),
    "adb -H host -P 5037 -i 05WAY1YE00",
  );
  assert.equal(canonicalCommand({ wireless: { host: "h", port: 5555 } }), "adb connect h:5555");
  assert.equal(
    canonicalCommand({ wireless: { host: "h", port: 5555 }, serial: "h:5555", serverHost: "relay", serverPort: 5037 }),
    "adb -H relay -P 5037 connect h:5555",
  );
});

test("parseWirelessTarget defaults to port 5555", () => {
  assert.deepEqual(parseWirelessTarget("10.0.0.9"), { host: "10.0.0.9", port: 5555 });
  assert.deepEqual(parseWirelessTarget("10.0.0.9:5556"), { host: "10.0.0.9", port: 5556 });
  assert.deepEqual(parseWirelessTarget("fe80::1%wlan0"), { host: "fe80::1%wlan0", port: 5555 });
});

test("deviceArgs always receives the resolved transport serial, never the identity (V28)", () => {
  const identity = parseAdbCommand("adb -i 05WAY1YE00");
  assert.throws(() => deviceArgs(identity), /cannot select a device by ro.serialno/);
  assert.deepEqual(deviceArgs(identity, "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp"), [
    "-s",
    "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp",
  ]);
  assert.deepEqual(deviceArgs(parseAdbCommand("adb")), []);
  assert.deepEqual(deviceArgs(parseAdbCommand("adb -d")), ["-d"]);
  assert.deepEqual(deviceArgs(parseAdbCommand("adb -e")), ["-e"]);
  assert.deepEqual(deviceArgs(parseAdbCommand("adb -t 94")), ["-t", "94"]);
  assert.deepEqual(deviceArgs(parseAdbCommand("adb connect 10.0.0.9:5556")), ["-s", "10.0.0.9:5556"]);
  assert.deepEqual(deviceArgs(parseAdbCommand("adb -H h -P 5038 -t 3"), "serial-9"), ["-H", "h", "-P", "5038", "-s", "serial-9"]);
});

test("a quoting-hostile identity is rejected before it reaches adb", () => {
  assert.throws(() => parseAdbCommand("adb -i a'b"), /incomplete quoting or escaping/);
});
