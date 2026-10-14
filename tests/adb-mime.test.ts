import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionMime, IMAGE_MIME_TYPES, isImageMime, isTextMimeType, looksLikeText, sniffFileKind } from "../src/adb/mime.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 7)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(24, 7)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(16, 7)]);

test("image magic wins over the extension (V11)", () => {
  assert.deepEqual(sniffFileKind(PNG, "/data/local/tmp/blob"), { mime: "image/png", kind: "image" });
  assert.deepEqual(sniffFileKind(JPEG, "/sdcard/DCIM/noext"), { mime: "image/jpeg", kind: "image" });
  assert.deepEqual(sniffFileKind(GIF, "/sdcard/x.bin"), { mime: "image/gif", kind: "image" });
  assert.deepEqual(sniffFileKind(WEBP, "/sdcard/x"), { mime: "image/webp", kind: "image" });
  // A truncated header is not an image: RIFF without WEBP at offset 8.
  assert.notEqual(sniffFileKind(Buffer.from("RIFF\x10\x00\x00\x00AAAA"), "/x.wav").kind, "image");
});

test("text is text, binary is binary (F5)", () => {
  const text = Buffer.from("line one\r\nline two – ok\n", "utf8");
  assert.deepEqual(sniffFileKind(text, "/data/local/tmp/notes.txt"), { mime: "text/plain", kind: "text" });
  assert.deepEqual(sniffFileKind(text, "/data/local/tmp/no-extension"), { mime: "text/plain", kind: "text" });
  // A text extension with binary bytes keeps the declared MIME but is classified binary (F5).
  assert.deepEqual(sniffFileKind(Buffer.concat([Buffer.from("AB"), Buffer.from([0]), Buffer.from("CD")]), "/x.log"), {
    mime: "text/plain",
    kind: "binary",
  });
  assert.deepEqual(sniffFileKind(Buffer.from([0xff, 0xfe, 0xff]), "/data/local/tmp/blob"), {
    mime: "application/octet-stream",
    kind: "binary",
  });
  assert.equal(looksLikeText(Buffer.from([0x61, 0x00])), false);
  assert.equal(looksLikeText(Buffer.from("a\tb\rc\n")), true);
  assert.equal(looksLikeText(Buffer.from([0x61, 0x07])), false, "bell is C0");
  assert.equal(looksLikeText(Buffer.from([0xc3, 0x28])), false, "invalid UTF-8 sequence");
});

test("an image extension without magic still classifies as image (D6b fast path)", () => {
  const fake = Buffer.from("plain text pretending", "utf8");
  assert.deepEqual(sniffFileKind(fake, "/sdcard/fake.png"), { mime: "image/png", kind: "image" });
  assert.equal(sniffFileKind(Buffer.from([2, 3, 4, 5]), "/x.txt").kind, "binary");
});

test("extension table covers the android containers", () => {
  assert.equal(extensionMime("/data/app/x.apk"), "application/vnd.android.package-archive");
  assert.equal(extensionMime("a.tar.gz"), "application/gzip");
  assert.equal(extensionMime("/sdcard/MOV_0001.mp4"), "video/mp4");
  assert.equal(extensionMime("/data/local/tmp/index.ts"), "text/typescript");
  assert.equal(extensionMime("/data/local/tmp/README"), undefined);
  assert.equal(extensionMime("/data/local/tmp/.hidden"), undefined);
});

test("MIME predicates match the read path's contract", () => {
  assert.deepEqual([...IMAGE_MIME_TYPES], ["image/jpeg", "image/png", "image/gif", "image/webp"]);
  assert.ok(isImageMime("image/png"));
  assert.equal(isImageMime("image/tiff"), false);
  assert.equal(isImageMime(null), false);
  assert.ok(isTextMimeType("text/plain"));
  assert.ok(isTextMimeType("application/json"));
  assert.ok(isTextMimeType("application/xml"));
  assert.ok(isTextMimeType("text/x-shellscript"));
  assert.equal(isTextMimeType("application/vnd.android.package-archive"), false);
  assert.equal(isTextMimeType("application/octet-stream"), false);
});
