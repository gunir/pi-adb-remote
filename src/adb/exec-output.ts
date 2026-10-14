/**
 * Bounded execution output: streaming accumulator, host spill file, and preview rendering.
 *
 * A device can emit gigabytes (logcat, `dd`, a runaway loop), so nothing here may buffer
 * without a ceiling: the accumulator keeps a tail for the model, spills the full stream to a
 * host file, and reports `hardCapHit` once the spill file itself exceeds its budget (F24).
 */

import { closeSync, mkdirSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";

/** Bytes held back from the content budget so the truncation footer always fits. */
export const OUTPUT_FOOTER_RESERVE_BYTES = 512;
/** Default ceiling for the spill file itself (plan §5.7, D13). */
export const SPILL_CAP_BYTES = 64 * 1024 * 1024;
/** Prefix for every host scratch artifact of this extension. */
export const OUTPUT_FILE_PREFIX = "pi-adb-remote-";

/** One host scratch directory per session (§4.5); index.ts removes it at shutdown. */
export function createSessionOutputDir(): string {
  return mkdtempSync(join(tmpdir(), `${OUTPUT_FILE_PREFIX}session-`));
}

export interface OutputFile {
  path: string;
  fd: number;
}

export function createOutputFile(directory?: string, name = "output.log"): OutputFile {
  const dir = directory ?? mkdtempSync(join(tmpdir(), `${OUTPUT_FILE_PREFIX}output-`));
  if (directory) mkdirSync(directory, { recursive: true });
  return { path: join(dir, name), fd: openSync(join(dir, name), "w", 0o600) };
}

export function saveOutput(content: string | Buffer, directory?: string, name = "output.txt"): string {
  const file = createOutputFile(directory, name);
  try {
    writeSync(file.fd, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  } finally {
    closeSync(file.fd);
  }
  return file.path;
}

export interface AccumulatorResult {
  text: string;
  content: string;
  fullOutputPath?: string;
  truncation: {
    truncated: boolean;
    outputLines: number;
    totalLines: number;
    totalBytes: number;
    maxLines: number;
    maxBytes: number;
  };
}

export class DeviceExecAccumulator {
  private chunks: Buffer[] = [];
  private tail = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private outputFile: OutputFile | undefined;
  private spilledBytes = 0;
  private totalBytes = 0;
  private newlineCount = 0;
  private lastByte: number | undefined;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly spillCapBytes: number;
  private readonly outputDir: string | undefined;
  /** True once the stream outgrew `spillCapBytes`; the caller must kill the child (F24). */
  hardCapHit = false;

  constructor(maxLines: number, maxBytes: number, spillCapBytes = SPILL_CAP_BYTES, outputDir?: string) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.spillCapBytes = spillCapBytes;
    this.outputDir = outputDir;
  }

  get bytesSeen(): number {
    return this.totalBytes;
  }

  append(chunk: Buffer): void {
    if (!chunk.length) return;
    this.totalBytes += chunk.length;
    for (const byte of chunk) if (byte === 10) this.newlineCount++;
    this.lastByte = chunk[chunk.length - 1];

    if (!this.outputFile && this.totalBytes > this.maxBytes) {
      this.outputFile = createOutputFile(this.outputDir);
      for (const previous of this.chunks) writeSync(this.outputFile.fd, previous);
      this.chunks = [];
    }
    if (this.outputFile) {
      if (this.spilledBytes + chunk.length > this.spillCapBytes) {
        // Keep the spill file inside its budget: retain the head, drop the middle, remember it.
        const room = Math.max(0, this.spillCapBytes - this.spilledBytes);
        if (room > 0) writeSync(this.outputFile.fd, chunk.subarray(0, room));
        this.spilledBytes += chunk.length;
        this.hardCapHit = true;
      } else {
        writeSync(this.outputFile.fd, chunk);
        this.spilledBytes += chunk.length;
      }
    } else {
      this.chunks.push(chunk);
    }

    this.tail = Buffer.concat([this.tail, chunk]);
    const tailBytes = this.maxBytes + OUTPUT_FOOTER_RESERVE_BYTES + 4096;
    if (this.tail.length > tailBytes) this.tail = this.tail.subarray(this.tail.length - tailBytes);
  }

  appendStderr(chunk: Buffer): void {
    this.stderrTail = Buffer.concat([this.stderrTail, chunk]);
    if (this.stderrTail.length > this.maxBytes) {
      this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - this.maxBytes);
    }
  }

  private ensureOutputFile(): string {
    if (!this.outputFile) {
      this.outputFile = createOutputFile(this.outputDir);
      for (const chunk of this.chunks) writeSync(this.outputFile.fd, chunk);
    }
    return this.outputFile.path;
  }

  finish(): AccumulatorResult {
    const totalLines = this.totalBytes ? this.newlineCount + (this.lastByte === 10 ? 0 : 1) : 0;
    const source = this.outputFile ? this.tail.toString("utf8") : Buffer.concat(this.chunks).toString("utf8");
    const contentBudget = Math.max(1, this.maxBytes - OUTPUT_FOOTER_RESERVE_BYTES);
    const base = truncateTail(source, { maxLines: this.maxLines, maxBytes: contentBudget });
    const truncated = this.totalBytes > contentBudget || totalLines > this.maxLines || base.truncated;
    const truncation = {
      truncated,
      outputLines: base.outputLines,
      totalLines,
      totalBytes: this.totalBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    const content = base.content || "Device command completed.";
    let fullOutputPath: string | undefined;
    let text = content;
    if (truncated) {
      fullOutputPath = this.ensureOutputFile();
      const startLine = Math.max(1, totalLines - base.outputLines + 1);
      const capNote = this.hardCapHit ? `, output capped at ${formatSize(this.spillCapBytes)}` : "";
      text += `\n\n[Showing lines ${startLine}-${totalLines} of ${totalLines} (${formatSize(this.maxBytes)} model-output limit${capNote}). Full output: ${fullOutputPath}]`;
    }
    this.close();
    return { text, content, truncation, fullOutputPath };
  }

  errorMessage(): string {
    return this.stderrTail.toString("utf8").trim();
  }

  close(): void {
    if (!this.outputFile) return;
    const file = this.outputFile;
    this.outputFile = undefined;
    closeSync(file.fd);
  }
}

export function previewDeviceOutput(output: string, displayLines: number): string {
  return (
    truncateTail(output, { maxLines: displayLines, maxBytes: DEFAULT_MAX_BYTES }).content || "Device command completed."
  );
}
