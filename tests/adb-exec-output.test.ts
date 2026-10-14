import assert from "node:assert/strict";
import { closeSync, existsSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  createOutputFile,
  createSessionOutputDir,
  DeviceExecAccumulator,
  OUTPUT_FILE_PREFIX,
  previewDeviceOutput,
  saveOutput,
  SPILL_CAP_BYTES,
} from "../src/adb/exec-output.ts";

const scratch = createSessionOutputDir();
after(() => rmSync(scratch, { recursive: true, force: true }));

function feed(accumulator: DeviceExecAccumulator, text: string, chunkSize = 4096): void {
  const buffer = Buffer.from(text, "utf8");
  for (let offset = 0; offset < buffer.length; offset += chunkSize) accumulator.append(buffer.subarray(offset, offset + chunkSize));
}

test("the spill prefix identifies this extension's host scratch", () => {
  assert.ok(scratch.includes(`${OUTPUT_FILE_PREFIX}session-`), scratch);
  assert.equal(createSessionOutputDir().includes(OUTPUT_FILE_PREFIX), true);
});

test("10 000 lines: tail-only model text, complete readable spill file (F24)", () => {
  const accumulator = new DeviceExecAccumulator(200, 8192, SPILL_CAP_BYTES, scratch);
  const lines = Array.from({ length: 10_000 }, (_unused, index) => `line-${index}-payload`);
  feed(accumulator, lines.join("\n") + "\n", 1000);

  const result = accumulator.finish();
  assert.equal(result.truncation.truncated, true);
  assert.equal(result.truncation.totalLines, 10_000);
  assert.equal(result.truncation.totalBytes, Buffer.byteLength(lines.join("\n") + "\n"));
  assert.ok(result.text.includes("line-9999-payload"), "model sees the tail");
  assert.ok(!result.text.includes("line-0-payload"), "model does not see the head");
  assert.match(result.text, /\[Showing lines \d+-10000 of 10000 \(.+ model-output limit\)\. Full output: /);
  assert.ok(result.fullOutputPath && existsSync(result.fullOutputPath));
  const spilled = readFileSync(result.fullOutputPath, "utf8").trimEnd().split("\n");
  assert.equal(spilled.length, 10_000);
  assert.equal(spilled[0], "line-0-payload");
  assert.equal(spilled.at(-1), "line-9999-payload");
});

test("a stream beyond spillCapBytes reports the cap and bounds the file", () => {
  // The "2 GB" case of plan §5.1 is the same code path; it is exercised against the device in
  // step 11 (`exec-out cat /dev/zero`), so this offline test uses a proportionally smaller flood.
  const spillCap = 256 * 1024;
  const accumulator = new DeviceExecAccumulator(50, 4096, spillCap, scratch);
  const flood = "x".repeat(4 * 1024 * 1024);
  feed(accumulator, flood, 64 * 1024);
  assert.equal(accumulator.hardCapHit, true, "caller kills the child on this signal");

  const result = accumulator.finish();
  assert.ok(result.fullOutputPath);
  assert.ok(readFileSync(result.fullOutputPath).length <= spillCap);
  assert.match(result.text, /output capped at /);
  assert.equal(accumulator.bytesSeen, flood.length);
});

test("small output is returned verbatim without a spill file", () => {
  const accumulator = new DeviceExecAccumulator(200, 8192, SPILL_CAP_BYTES, scratch);
  feed(accumulator, "ok\n");
  const result = accumulator.finish();
  assert.equal(result.content, "ok\n");
  assert.equal(result.truncation.truncated, false);
  assert.equal(result.fullOutputPath, undefined);
  assert.deepEqual(result.truncation, {
    truncated: false,
    outputLines: 1,
    totalLines: 1,
    totalBytes: 3,
    maxLines: 200,
    maxBytes: 8192,
  });
});

test("an empty stream still renders a sentence", () => {
  const accumulator = new DeviceExecAccumulator(200, 8192, SPILL_CAP_BYTES, scratch);
  assert.equal(accumulator.finish().content, "Device command completed.");
  assert.equal(previewDeviceOutput("", 5), "Device command completed.");
});

test("stderr is kept separately for error text", () => {
  const accumulator = new DeviceExecAccumulator(10, 128, SPILL_CAP_BYTES, scratch);
  accumulator.appendStderr(Buffer.from("first error\n"));
  accumulator.appendStderr(Buffer.from("second error\n"));
  assert.equal(accumulator.errorMessage(), "first error\nsecond error");
  const big = new DeviceExecAccumulator(10, 16, SPILL_CAP_BYTES, scratch);
  big.appendStderr(Buffer.from("a".repeat(200)));
  assert.ok(big.errorMessage().length <= 16);
});

test("output helpers write under the requested directory", () => {
  const path = saveOutput("hello", scratch, "note.txt");
  assert.equal(readFileSync(path, "utf8"), "hello");
  assert.ok(path.startsWith(scratch));
  const file = createOutputFile(join(scratch, "nested"), "output.log");
  writeSync(file.fd, "nested write");
  closeSync(file.fd);
  assert.equal(readFileSync(join(scratch, "nested", "output.log"), "utf8"), "nested write");
  // A saveOutput without a directory creates its own under the session prefix; take it back down
  // so the suite leaves no temporary directories behind.
  const autoCreated = saveOutput("standalone");
  assert.ok(autoCreated.includes(OUTPUT_FILE_PREFIX));
  rmSync(dirname(autoCreated), { recursive: true, force: true });
});

test("previewDeviceOutput honours the display-lines setting", () => {
  const text = Array.from({ length: 40 }, (_unused, index) => `row ${index}`).join("\n");
  const preview = previewDeviceOutput(text, 5);
  assert.equal(preview.split("\n").length, 5);
  assert.ok(preview.endsWith("row 39"));
  assert.equal(previewDeviceOutput("single\n", 5), "single\n");
});
