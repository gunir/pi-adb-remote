import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHarness } from "./helpers/extension-harness.ts";

// ---------------------------------------------------------------------------
// Documentation contract (plan §6 step 10): every command, action, config key and
// default that the human-facing docs advertise must exist in the extension itself.
// The comparison target is the *registered* surface - the command's own completions and
// the tool schema enum - so a renamed verb or a stale default fails here, not in front of
// a user.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "pi-adb-docs-"));
const deviceRoot = join(root, "device");
const workspace = join(deviceRoot, "ws");
const agentDir = join(root, "agent");

const fakeAdb = join(root, "fake-adb");
mkdirSync(workspace, { recursive: true });
// The documented default workspace has to exist in the sandbox, or the connect this file uses
// to reach the config surface fails on the directory check.
mkdirSync(join(deviceRoot, "data/local/tmp"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
copyFileSync(new URL("./fixtures/fake-adb.sh", import.meta.url), fakeAdb);
chmodSync(fakeAdb, 0o755);

const privateTmp = join(root, "tmp");
mkdirSync(privateTmp, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TMPDIR = privateTmp;
process.env.ADB = fakeAdb;
process.env.FAKE_ADB_ROOT = deviceRoot;
process.env.FAKE_ADB_DEVICES = "adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp device product:sargo model:Pixel_3a device:sargo transport_id:94";
// The fixture maps device paths onto the host, so the endpoint starts from an existing directory.
writeFileSync(join(agentDir, "adb-remote-config.json"), `${JSON.stringify({
  activeEndpoint: "adb",
  endpoints: { adb: { adbCommand: "adb", deviceCwd: workspace } },
}, null, 2)}\n`);

const repoRoot = new URL("..", import.meta.url).pathname;
const DOC_FILES = ["README.md", "README.zh-CN.md", "AGENTS.md"].map((name) => ({ name, text: readFileSync(join(repoRoot, name), "utf8") }));

const harness = createHarness({ cwd: workspace });

before(async () => {
  const { default: adbRemote } = await import("../index.ts");
  adbRemote(harness.api as never);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every value the registered `/adb` command can complete, disconnected and connected. */
const commandSurface = async (): Promise<Set<string>> => {
  const command = harness.commands.get("adb");
  assert.ok(command?.getArgumentCompletions, "the /adb command exposes argument completions");
  const values = new Set<string>();
  // `config` items complete as `config note`; docs quote the sub-key, so compare last tokens.
  const collect = async (prefix: string) => {
    for (const item of (await command.getArgumentCompletions!(prefix)) ?? []) {
      values.add(item.value.split(/\s+/).pop()!);
    }
  };
  await collect("/adb ");
  await collect("/adb config ");
  await harness.callTool("adb", { action: "connect", command: "adb" });
  await collect("/adb ");
  await collect("/adb config ");
  await collect("/adb config forward ");
  await harness.callTool("adb", { action: "disconnect" });
  return values;
};

const documented = (pattern: RegExp): string[] => {
  const found = new Set<string>();
  for (const file of DOC_FILES) for (const match of file.text.matchAll(pattern)) found.add(match[1]!);
  return [...found].sort();
};

describe("documented command surface", () => {
  it("documents only /adb verbs the command actually completes", async () => {
    const surface = await commandSurface();
    // Exactly one space separates a real command from its operand; the aligned comment column
    // in the docs blocks is separated by a wide gap and is therefore not parsed as an argument.
    const documentedVerbs = documented(/\/adb {1,2}([a-z][a-z-]*)/g);
    for (const verb of ["use", "devices", "pair", "status", "disconnect", "config", "memory", "cd"]) {
      assert.ok(documentedVerbs.includes(verb), `the docs show /adb ${verb}`);
    }
    for (const verb of documentedVerbs) {
      assert.ok(surface.has(verb), `documented /adb verb "${verb}" is not offered by the command`);
    }
    assert.ok(surface.has("config"), "config is reachable from the command");
    assert.ok(surface.has("use"), "saved endpoints are selectable from the command");
  });

  it("documents only config keys the command actually accepts", async () => {
    const surface = await commandSurface();
    const configKeys = documented(/\/adb config {1,2}([a-z][a-z-]*)/g);
    assert.ok(configKeys.length >= 6, `config keys are documented: ${configKeys.join(",")}`);
    for (const key of configKeys) {
      assert.ok(surface.has(key), `documented config key "${key}" is not offered by /adb config`);
    }
  });

  it("documents only the exec flags the command completes", async () => {
    const command = harness.commands.get("adb")!;
    const items: Array<{ value: string }> = (await command.getArgumentCompletions?.("/adb exec --")) ?? [];
    const offered = new Set(items.map((item) => item.value.split(/\s+/).pop()!));
    assert.ok(offered.size >= 2, `the command completes exec flags: ${[...offered].join(",")}`);
    const documentedFlags = new Set<string>();
    for (const file of DOC_FILES) for (const match of file.text.matchAll(/\/adb exec (--[a-z-]+)/g)) documentedFlags.add(match[1]!);
    assert.ok(documentedFlags.size >= 2, `the docs show exec flags: ${[...documentedFlags].join(",")}`);
    for (const flag of [...documentedFlags].sort()) {
      assert.ok(offered.has(flag), `documented flag "${flag}" is not offered by /adb exec`);
    }
  });

  it("documents only actions in the adb tool schema", () => {
    const actionEnum: readonly string[] | undefined = (harness.tools.get("adb")?.parameters as any)?.properties?.action?.enum;
    assert.ok(actionEnum?.length, "the adb tool declares an action enum");
    const documentedActions = new Set<string>();
    for (const file of DOC_FILES) {
      for (const match of file.text.matchAll(/adb\(action="([a-z]+)"\)/g)) documentedActions.add(match[1]!);
      for (const match of file.text.matchAll(/"action":\s*"([a-z]+)"/g)) documentedActions.add(match[1]!);
    }
    assert.ok(documentedActions.size >= 3, `actions are documented: ${[...documentedActions].join(",")}`);
    for (const name of [...documentedActions].sort()) {
      assert.ok(actionEnum!.includes(name), `documented action "${name}" is not in the tool schema`);
    }
    // ...and the reverse direction: the documented action table covers the whole schema.
    const actionTable = DOC_FILES.map((file) => file.text).join("\n");
    for (const name of actionEnum!) {
      assert.match(actionTable, new RegExp(`\`${name}\``), `action "${name}" is missing from the documentation`);
    }
  });
});

describe("documented configuration and defaults", () => {
  it("documents only config keys the extension reports and writes", async () => {
    const blocks = [...DOC_FILES[0]!.text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
    const body = blocks.find((text) => text.includes('"endpoints"'));
    assert.ok(body, "README.md shows a configuration example");
    const parsed = JSON.parse(body!.replace(/0A1B2C3D4E5F6/g, "SERIAL"));
    const documentedKeys = [
      ...Object.keys(parsed).filter((key) => key !== "endpoints"),
      ...Object.keys(parsed.endpoints?.[Object.keys(parsed.endpoints ?? {})[0] ?? ""] ?? {}),
    ];
    assert.ok(documentedKeys.length >= 10, `the config surface is documented: ${documentedKeys.join(",")}`);

    await harness.callTool("adb", { action: "connect", command: "adb" });
    // Every documented key has to be reachable through `/adb config` and land in the file.
    const setters: Record<string, string> = {
      activeEndpoint: "cwd /data/local/tmp",
      adbCommand: "cwd /data/local/tmp",
      deviceCwd: "cwd /data/local/tmp",
      note: 'note "docs phone"',
      forwards: "forward 19042:tcp:9",
      imageMaxBytes: "image-max-bytes 2097152",
      displayLines: "display-lines 7",
      readMaxBytes: "read-max-bytes 20000",
      readMaxLines: "read-max-lines 50",
      execMaxBytes: "exec-max-bytes 4096",
      execMaxLines: "exec-max-lines 60",
      turnMaxBytes: "turn-max-bytes 40000",
    };
    for (const key of documentedKeys) {
      assert.ok(setters[key], `\`/adb config ${key}\` is reachable from the command`);
      await harness.runCommand("adb", `config ${setters[key]}`);
    }
    const written = JSON.parse(readFileSync(join(agentDir, "adb-remote-config.json"), "utf8")) as Record<string, any>;
    const storedKeys = new Set([...Object.keys(written), ...Object.keys(written.endpoints?.adb ?? {})]);
    for (const key of documentedKeys) {
      assert.ok(storedKeys.has(key), `documented config key "${key}" never reaches adb-remote-config.json`);
    }

    // Every documented key is also surfaced to the user by `/adb config`.
    harness.notifications.length = 0;
    await harness.runCommand("adb", "config");
    const dump = harness.notifications.map((entry) => entry.text).join("\n");
    const labels: Record<string, RegExp> = {
      activeEndpoint: /^\* adb$/m,
      adbCommand: /^\s+adb: adb$/m,
      deviceCwd: /cwd:/,
      note: /note:/,
      forwards: /forward:/,
      imageMaxBytes: /image cap:/,
      displayLines: /Display lines:/,
      readMaxBytes: /Read output: .*\//,
      readMaxLines: /Read output: \d+ lines/,
      execMaxBytes: /Exec output: .*\//,
      execMaxLines: /Exec output: \d+ lines/,
      turnMaxBytes: /Per-turn output:/,
    };
    for (const key of documentedKeys) {
      const label = labels[key];
      assert.ok(label, `the config dump has a documented label for "${key}"`);
      assert.match(dump, label, `\`/adb config\` reports ${key}`);
    }
  });

  it("keeps the English and Chinese guides structurally aligned", () => {
    const [english, chinese] = DOC_FILES;
    const configKeysOf = (text: string) => {
      const body = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!).find((block) => block.includes('"endpoints"'));
      const parsed = JSON.parse(body!.replace(/0A1B2C3D4E5F6/g, "SERIAL"));
      return [...Object.keys(parsed).filter((key) => key !== "endpoints"), ...Object.keys(Object.values(parsed.endpoints)[0] ?? {})].sort();
    };
    assert.deepEqual(configKeysOf(chinese!.text), configKeysOf(english!.text), "both guides document the same configuration surface");
    for (const key of configKeysOf(english!.text)) {
      assert.ok(chinese!.text.includes(`\`${key}\``), `README.zh-CN.md documents ${key}`);
    }
    const releaseRow = /\| \[0\.1\.0\]\(([^)]+)\) \|/g;
    const englishRelease = english!.text.match(releaseRow)?.[0];
    const chineseRelease = chinese!.text.match(releaseRow)?.[0];
    assert.ok(englishRelease && chineseRelease, "both guides carry the 0.1.0 release row");
    assert.equal(/\(([^)]+)\)/.exec(englishRelease!)![1], /\(([^)]+)\)/.exec(chineseRelease!)![1], "both release rows link the same changelog anchor");
  });

  it("documents the defaults the extension actually reports", async () => {
    // The previous case wrote non-default values, so start over from a pristine endpoint entry.
    // (The fixture maps device paths onto the host, so the endpoint keeps an existing directory.)
    writeFileSync(join(agentDir, "adb-remote-config.json"), `${JSON.stringify({
      activeEndpoint: "adb",
      endpoints: { adb: { adbCommand: "adb", deviceCwd: workspace } },
    }, null, 2)}\n`);
    await harness.callTool("adb", { action: "connect", command: "adb" });
    harness.notifications.length = 0;
    await harness.runCommand("adb", "config");
    const printed = harness.notifications.map((entry) => entry.text).join("\n");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    // `/adb config` renders the effective values in human units; the README has to agree with them.
    const reported: Array<[string, RegExp, string[]]> = [
      ["display lines", /Display lines: 5\b/, ["5 (max 50)", "| 5 |"]],
      ["read lines", /Read output: 400 lines/, ["400"]],
      ["read bytes", /Read output: 400 lines \/ 16\.0KB/, ["16 KB"]],
      ["exec lines", /Exec output: 200 lines/, ["200"]],
      ["exec bytes", /Exec output: 200 lines \/ 8\.0KB/, ["8 KB"]],
      ["turn bytes", /Per-turn output: 32\.0KB/, ["32 KB"]],
      ["image cap", /image cap: 8\.0MB/, ["8 MB", "8388608"]],
      ["saved endpoint", /\* adb\n\s+note:/, ["`note`"]],
    ];
    for (const [label, inDump, inReadme] of reported) {
      assert.match(printed, inDump, `the extension reports the ${label} default`);
      assert.ok(inReadme.some((form) => readme.includes(form)), `README.md documents the ${label} default (${inReadme.join(" or ")})`);
    }
  });
});

function humanSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MiB` : `${bytes / 1024} KB`;
}
