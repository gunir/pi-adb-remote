/**
 * Host-side file typing. The device has no usable MIME source: toybox `file` rejects
 * `--mime-type` (V10) and its `-b` wording is ROM-specific (V11), so bytes are sniffed here
 * and the extension table is only a fast path (plan D6).
 */

/** The image set the read path accepts, unchanged from the previous transport. */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export interface FileKind {
  mime: string;
  kind: "image" | "text" | "binary";
}

const EXTENSION_MIME: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  svg: "image/svg+xml",
  // text-ish
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  ndjson: "application/x-ndjson",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  yml: "text/yaml",
  yaml: "text/yaml",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  properties: "text/plain",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  fish: "text/x-shellscript",
  py: "text/x-python",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  kt: "text/x-kotlin",
  kts: "text/x-kotlin",
  c: "text/x-c",
  h: "text/x-c",
  cc: "text/x-c++",
  cpp: "text/x-c++",
  hh: "text/x-c++",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  sql: "text/x-sql",
  toml: "text/plain",
  // android + binary containers
  apk: "application/vnd.android.package-archive",
  dex: "application/vnd.android.dex",
  jar: "application/java-archive",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  zst: "application/zstd",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  pdf: "application/pdf",
  so: "application/octet-stream",
  a: "application/octet-stream",
  o: "application/octet-stream",
  bin: "application/octet-stream",
  dat: "application/octet-stream",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4a: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  "3gp": "video/3gpp",
  gifv: "video/mp4",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

const TEXT_MIME_PATTERN = /^text\/|\/(?:json|xml|javascript|x-sh|x-shellscript|x-empty|x-ndjson|x-python|x-go|x-rust|x-java|x-kotlin|x-c|x-c\+\+|x-sql|typescript|csv|tab-separated-values|markdown|svg\+xml)$/;

function extensionOf(devicePath: string): string {
  const base = devicePath.slice(devicePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function extensionMime(devicePath: string): string | undefined {
  return EXTENSION_MIME[extensionOf(devicePath)];
}

export function isImageMime(mime: string | undefined | null): mime is string {
  return !!mime && (IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

export function isTextMimeType(mime: string): boolean {
  return TEXT_MIME_PATTERN.test(mime);
}

/** No NUL, no C0 beyond tab/newline/CR, and valid UTF-8 (plan §5.5). */
export function looksLikeText(sample: Buffer): boolean {
  for (const byte of sample) {
    if (byte === 0x0a || byte === 0x0d || byte === 0x09) continue;
    if (byte < 0x20) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function matchesMagic(sample: Buffer, magic: number[], offset: number): boolean {
  if (sample.length < offset + magic.length) return false;
  return magic.every((byte, index) => sample[offset + index] === byte);
}

function sniffImageMagic(sample: Buffer): string | undefined {
  if (matchesMagic(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)) return "image/png";
  if (matchesMagic(sample, [0xff, 0xd8, 0xff], 0)) return "image/jpeg";
  if (matchesMagic(sample, [0x47, 0x49, 0x46, 0x38], 0)) return "image/gif";
  // RIFF....WEBP
  if (matchesMagic(sample, [0x52, 0x49, 0x46, 0x46], 0) && matchesMagic(sample, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return undefined;
}

export function sniffFileKind(sample: Buffer, devicePath: string): FileKind {
  const magic = sniffImageMagic(sample);
  if (magic) return { mime: magic, kind: "image" };
  const mime = extensionMime(devicePath);
  if (mime && (IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return { mime, kind: "image" };
  const text = looksLikeText(sample);
  if (mime) return { mime, kind: text ? "text" : "binary" };
  return text
    ? { mime: "text/plain", kind: "text" }
    : { mime: "application/octet-stream", kind: "binary" };
}
