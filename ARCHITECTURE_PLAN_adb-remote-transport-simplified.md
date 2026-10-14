# PLAN — switch `pi-ssh-remote` from SSH to adb (in place)

Status: **v4 (simplified) — retained as an alternative, not what shipped.** The repository implements
`ARCHITECTURE_PLAN_adb-remote-transport.md` (v3): the package is the renamed artifact `pi-adb-remote`, the
SSH stack is deleted, and the transport lives in `src/adb/*`. Read that file for the design that the code
follows; this document is kept for the record and must not be used as instructions.

## 1. Goal and scope

`pi-ssh-remote` routes Pi's `read` / `write` / `edit` / `bash` tools to a remote host over one long-lived `ssh2` client (exec channels + SFTP + forwarded channels). After this change the "remote" is **an Android device reached through the `adb` CLI**. Everything above the transport (config, endpoints, notes, server memory, output budgets, truncation, renderers, `/remote` command, autocomplete, session restore) stays.

**Principle:** replace the transport with the smallest thing that works; do not add features. Each `adb` call is a short-lived subprocess (~20 ms measured by the v3 author), so there is no connection object, no reconnect machinery, no keepalive.

**In place means:** same package name, same `/remote` command, same `remote` tool, same git history. Only the config/session file names change (§6) so stale SSH data is never read.

**Out of scope** (could be follow-ups, none are needed for the swap): `screen`/`pull`/`push`/`install`/`pair` actions, root/`su`, `adb root`/`reboot`, device-backed `grep`/`find`/`ls`, serial-number identity resolution, atomic write staging, a capability probe, a fake-adb test harness, renaming the package.

## 2. Device facts the design relies on

Measured by the v3 author on a Pixel 3a, Android 12, platform-tools 35.0.2 (not re-measured by me; step 1 re-checks the ones marked ★).

| Fact | Consequence |
|---|---|
| `adb shell` returns the real exit code and separate stderr (shell protocol v2) | one exec primitive is enough |
| No `bash`; `/system/bin/sh` is mksh; toybox applets `timeout sed head stat find grep cp mv rm mkdir readlink` exist | `bash -lc` wrapper must go; use `sh -c` |
| toybox `timeout` rejects `--kill-after=5s` (rc 125); `timeout -k 5 -s TERM N` works | new timeout wrapper |
| `file --mime-type` does not exist | sniff image magic on the host |
| `HOME=/`, cwd `/`; `/data/local/tmp` is writable; `/system` read-only; `/sdcard` is noexec | default cwd `/data/local/tmp`, not `~` |
| `shell -T -e none -n` is safe for every exec; killing the local `adb` leaves no orphan for `shell -T` | abort = kill the child |
| `sed -n 'a,bp' f \| head -c N` through `shell -T` is byte-identical to the file (CRLF preserved) | text range reads use `shell` |
| ★ `cat f` and `cat > f` (stdin) through `shell -T` are byte-exact, including NUL | no `exec-out`/`push`/`pull` needed |
| ★ `cd -- '<dir>' && pwd -P` works in mksh | cwd handling unchanged |
| `adb: device 'X' not found` / `device offline` / `unauthorized` / `more than one device` are distinct stderr texts | tiny hint function |

Minimum supported: Android 7+ (shell protocol v2) and a recent platform-tools (`shell -T`). Document this in the README; do not add fallbacks for older devices.

## 3. Design

```
index.ts  (tool routing, state, UI — keeps its structure)
   │  uses
src/adb.ts  (new, ~120 lines: parse target, spawn adb, build device command, error hint)
   │  spawn(adb, argv, {shell:false})
adb server :5037 ── device sh (mksh)
```

One new file, `src/adb.ts`. `src/ssh/*` is deleted. `src/shell.ts` stays (`quote` is the only escaping layer needed because argv is never passed through a host shell).

### 3.1 `src/adb.ts`

```ts
export interface ParsedAdb {
  command: string;      // canonical key: "adb", "adb -d", "adb -e", "adb -s SERIAL"
  selector: string[];   // [] | ["-d"] | ["-e"] | ["-s", serial]
  serial?: string;
  label: string;        // serial, or "usb device" / "emulator" / "device"
}
export function parseAdbCommand(input: string): ParsedAdb;   // replaces parseSshCommand
export const cacheId = (d: ParsedAdb): string => d.command;   // endpoint key, same role as before

export interface AdbResult { code: number | null; stdout: Buffer; stderr: Buffer; timedOut: boolean }
export function runAdb(args: string[], o: {
  timeoutSeconds: number; stdin?: Buffer; signal?: AbortSignal;
  onStdout?: (c: Buffer) => void; onStderr?: (c: Buffer) => void;
}): Promise<AdbResult>;

export function deviceShell(d: ParsedAdb, command: string, o: Parameters<typeof runAdb>[1]): Promise<AdbResult>;
export function deviceCommand(cwd: string, command: string, timeoutSeconds: number): string;
export function adbHint(stderr: string): string;              // maps known stderr to an actionable line
```

**Grammar** (strict; anything else throws with the list below): `adb`, `adb -d`, `adb -e`, `adb -s SERIAL`, or a bare `SERIAL` / `host:port`. A leading `adb` and a trailing `shell` are optional and ignored. `-H/-P` are not parsed: adb already honours `ANDROID_ADB_SERVER_ADDRESS` / `ANDROID_ADB_SERVER_PORT`. No `pair`/`connect` sub-grammar: for wireless devices the user gives `host:port` and `establish` runs the idempotent `adb connect host:port` first (§3.3).

**`runAdb`:** `spawn(process.env.ADB || "adb", args, { shell: false })`; ENOENT → `adb not found: install Android platform-tools or set $ADB`. Kills the child on abort and at `timeoutSeconds + 8` (same grace as today, `index.ts:722`), reporting `timedOut`. Callers that capture whole output only run bounded commands (`head -c`, `pwd`), so no extra buffer cap is added; streaming callers feed the existing accumulator.

**`deviceShell`:** argv is `[...selector, "shell", "-T", "-e", "none", ...(stdin ? [] : ["-n"]), command]`.

**`deviceCommand`** (replaces `withRemoteTimeout`, `index.ts:186`):

```
cd -- '<cwd>' && timeout -k 5 -s TERM <ceil(N)> sh -c '<command>'
```

e.g. `cd -- '/data/local/tmp' && timeout -k 5 -s TERM 30 sh -c 'ls -la'`. Single quoting level, via `quote()`. `N` is rounded up because the original `${N}s` suffix form is not guaranteed on toybox.

**`adbHint`:** substring match on `not found` → "device not connected; run `/remote devices`", `offline` → "device offline; replug or run /remote reconnect", `unauthorized` → "accept the USB-debugging prompt on the phone", `more than one device` → "several devices attached; use `adb -s SERIAL`", `Address already in use` / `cannot rebind` → forward port is taken. Appended to errors, never used for control flow.

### 3.2 Operation mapping (replaces SFTP and ssh exec)

| Operation | Implementation |
|---|---|
| exec (bash tool, `remote exec`, `/remote exec`) | `deviceShell(deviceCommand(cwd, cmd, N), {onStdout, onStderr, signal})`; rc 124/137 or `timedOut` → `timeout:N` as today |
| read text range | `sed -n 'a,bp' -- path \| head -c M` (same command as `index.ts:1325`), then refuse if the bytes contain NUL |
| read image/bytes (`ReadOperations.readFile`) | `cat -- path \| head -c 8388609`; more than 8 MiB → error "file larger than 8 MiB" |
| `access` | `test -e path` (rc ≠ 0 → throw) |
| image detection | `head -c 12 -- path` and a 10-line magic check (PNG, JPEG, GIF, WebP) on the host; this call also doubles as the existence check for text reads, so a read is two spawns |
| write | `mkdir -p -- dir` (`WriteOperations.mkdir`) then `cat > path` with the content as stdin |
| edit | existing `read` + `write` ops; no new code |
| forward | `adb [-s S] forward --no-rebind tcp:L tcp:R`; remove with `forward --remove tcp:L` |

Writes are **not atomic**, which is exactly what `sftp.writeFile` was (truncate-and-write), so this is parity, not a regression. v3's staging dance is dropped on that basis.

### 3.3 Connection model: "selected + verified", not "socket"

There is no long-lived object, so the state machine, staleness timers, transient-state polling, read/mutate retry classes and `withReconnect` are all deleted. Rules:

- `establish(parsed, cwd)` = *(if serial looks like `host:port`: `adb connect`)* → `adb [sel] get-state` must print `device` (else throw with `adbHint`) → `cd -- <cwd> && pwd -P`, falling back to `DEFAULT_DEVICE_CWD` with the existing `unavailableCwd` notice.
- Operations just run. A failed call returns its stderr plus `adbHint`. The next call works again automatically if the device is back, because nothing was held open.
- `reconnect` (tool action and `/remote reconnect`) = `adb [sel] wait-for-device` capped at 30 s, then `establish`. It is explicit and never retried behind the model's back, so a half-run `pm install` or `input tap` is never repeated.
- `RemoteState` becomes `ParsedAdb & { cwd: string; unavailableCwd?: string }`.

### 3.4 What deliberately stays as is

`mapPath` / `remotePath` (v3 deleted it; **that was a bug**: Pi hands the tools absolute paths under the host project dir and `mapPath` is what rebases them onto the device cwd), `RemoteExecAccumulator`, `limitRemoteToolResult`, output budgets, renderers, notes, server memory, autocomplete machinery, `localRead/Write/Edit/Bash` and `targetsLocalServerMemory`, `session_start`/`session_shutdown` structure, `user_bash`, `context`, `before_agent_start`, single-flight `reconnectPromise`.

## 4. `index.ts` change list

Grouped by area; line numbers refer to the current file.

| Area | Change |
|---|---|
| Imports (9-11, 31, 36-38) | drop `ssh2` types, `net`; drop `CURSOR_MARKER`, `Key`, `matchesKey`, `Focusable` if unused afterwards; import `src/adb.ts` instead of `src/ssh/*` |
| Types (52-112) | `RemoteState` as in §3.3; `CredentialCache` → `RuntimeCache { resume?: … }` (no password maps); `sshCommand` → `adbCommand`, `remoteCwd` stays; `ForwardSpec` → `{ localPort, devicePort }`; drop the legacy `memory`/`serverMemories`/top-level `sshCommand` fields; `SessionRemoteState.version` stays 1 (new entry type name makes old entries invisible) |
| Constants (114-133) | files `adb-remote-config.json`, `adb-remote-memories`; delete `KNOWN_HOSTS_FILE`; `FALLBACK_REMOTE_CWD` → `DEFAULT_DEVICE_CWD = "/data/local/tmp"`; `SESSION_STATE_ENTRY_TYPE = "pi-adb-remote-state"`; `CACHE_KEY = "__piAdbRemoteRuntimeV1"`; routing descriptions say "adb" |
| Helpers (138-210) | `serverMemoryId` → `parsed.command`; `parseForwardSpec` → `LOCAL:DEVICE` ints (1-65535); delete `withRemoteTimeout`; `commandFromEndpointKey` deleted |
| Config (211-279, 395-399) | `normalizeRemoteConfig` loses every legacy branch (memories, top-level ssh fields, key-derived command); endpoint entry validated by `parseAdbCommand`, invalid ones dropped |
| Memory (420-527) | delete `legacyMemoryEntries` / `migrateLegacyServerMemories` and the call at 834; delete `loadKnownHosts` / `saveKnownHost` / `displayFingerprint` |
| `endpointDisplayLabel` (413) | drop the `jumps` chain |
| Output (545-642) | unchanged except file prefix `pi-adb-remote-output-` |
| Exec (710-804) | `execRemote` / `execRemoteLimited` re-implemented on `deviceShell` with the same signatures minus `client`; delete `getSftp`, `withSftp`, `isReconnectable` |
| Secrets (806-831) | delete `SecretInput`, `askSecret` (no credentials exist) |
| Extension body | delete `auth` (835), `forwardServers` (842), `attachClient` (994-1006), `connectRoute` (1007-1050), `withReconnect` (1113-1122); `establish` / `reconnectRemote` / `connectInteractive` / `ensureConnected` / `changeRemoteCwd` / `restoreSessionRemoteState` keep their shape but per §3.3 (no `client`, no host-key prompt); `disconnect` loses `forgetCredentials` |
| Forwards (1206-1236) | `startForward` / `stopForwards` become `adb forward` / `forward --remove` over `forwardSpecs` (the map is the definition of "ours"; `--remove-all` is never called); status line reads `forwardSpecs` |
| File ops (1284-1371) | `remoteReadOps`, `executeRemoteRead`, `remoteWriteOps`, `remoteBashOps` per §3.2; `detectRemoteMimeType` / `isTextMimeType` / `openExecChannel` deleted |
| `remote` tool (1413-1551) | actions `connect reconnect devices status disconnect forward unforward exec chdir note memory` (`forget` removed, `devices` added = `adb devices -l`); descriptions/guidelines rewritten for adb; `command` param text: `adb`, `adb -s SERIAL`, `host:port` |
| `/remote` command (1553-1775) | `ssh …` branch → `adb …`; add `devices`; delete `forget`; config help text; bare `/remote` prompts "adb target:"; bare input falls through to `connectInteractive` as today |
| Autocomplete (280-394) | `ssh` item → `adb`, add `devices`, drop `forget`; `forward` description updated |
| Events | `before_agent_start` section names `adb_remote_*`; `context` `customType: "adb-remote-server-memory"`; workspace prompt below |

**Workspace prompt** (`remoteWorkspacePrompt`, `index.ts:500`): *Android device workspace: <label>:<cwd>. read/write/edit/bash run on the device; you are already in the device shell, so never prefix commands with `adb shell`. POSIX sh (mksh) and toybox only: no bash, curl or systemd. `/system` is read-only, `/sdcard` cannot execute files, `/data/local/tmp` is the writable workspace. Bound output with `logcat -d -t N`, `dumpsys X | head`, `tail -n 200`. Pi's `ls`/`grep`/`find`, if enabled, search the PC, not the device; use bash with `ls -la`, `grep -R -n -E`, `find DIR -maxdepth N -name GLOB`.*

The extension registers no `ls`/`grep`/`find` today and still will not, so v3's spike and guard tools are unnecessary.

## 5. Build order

Each step leaves the tree type-clean where the repo already type-checks; the SSH deletion and the `index.ts` rewrite land together so no commit is half-migrated.

1. **Live check (10 min, one device):** confirm the ★ rows of §2: `cat`/`cat >` byte-exact with NUL and CRLF through `shell -T`, `cd -- '<dir>' && pwd -P`, and `timeout -k 5 -s TERM 1 sleep 3` → rc 124. If `cat` is not byte-exact, switch only read/write to `exec-out` / `push`; nothing else in the plan moves.
2. **`src/adb.ts` + `tests/adb.test.ts`** (`node --test`, Node ≥ 22.18, dev-only, no new dependencies): grammar forms and rejections, canonical-command round trip, `deviceCommand` golden strings (cwd containing `'`, `$`, backtick), `adbHint` on each stderr text, `runAdb` against `node -e` as a stand-in binary via `$ADB` (exit code, stderr, timeout kill, abort, stdin).
3. **`index.ts` + delete `src/ssh/*`** per §4; `src/shell.ts` error text "in SSH command" → "in adb command".
4. **Docs and metadata:** `package.json` (`description`, `keywords` `adb`/`android`, remove `ssh2` and `ssh-config` from `dependencies`, keep `name`; retarget `repository`/`homepage`/`bugs` only if the GitHub repo changed), regenerate `package-lock.json`, update `README.md` and `README.zh-CN.md` (min Android 7+, platform-tools, grammar, the `/remote devices` flow, out-of-scope notes), add a `CHANGELOG.md` entry under `[Unreleased]`: **Changed** "transport is now adb; SSH is no longer supported (breaking)", **Removed** "SSH auth, host-key trust, ProxyJump, `forget`", **Added** "`/remote devices`". Release tables and version stay untouched until a release is requested.
5. **Validate:** `npm test`, extension-load validation, `git diff --check`, `npm pack --dry-run` (no `src/ssh/*`), `grep -rniw "ssh\|sftp\|ssh2" index.ts src README.md` empty (aside from the changelog), then a live pass on the device: `read` an offset range, `read` a PNG, `write` + `read` round trip, `edit`, `bash` with `cd` persistence, a timeout (`sleep 60` with timeout 2), abort mid-`logcat`, `forward` + `curl 127.0.0.1:L`.
6. **One commit:** `feat(remote): switch transport from ssh to adb`.

**Versioning (per `AGENTS.md`, no amendment needed):** this is a compatibility-breaking change, which the policy reserves for a new minor line, so the next release is `0.2.0`, not a reset to `0.1.0`. Release steps remain user-gated.

## 6. Decisions and what v3 got wrong

| Decision | Why |
|---|---|
| Modify in place; keep `/remote`, `remote`, package name | the request; no second package is installed, so v3's shadowing concern (D2) does not apply |
| New config/memory/session names (`adb-remote-*`, `pi-adb-remote-state`) | old files hold SSH endpoints; fresh names avoid migration and legacy-branch code altogether |
| Persist the serial the user gave; no `ro.serialno` identity layer | USB serials and `host:port` are stable; an mDNS serial that rots yields `not found` plus a hint to run `/remote devices`. v3's resolver, collision handling, `-i` pseudo-flag (which clashes with adb's own `-i`) and `lastTransportSerial` hint solved a corner case at the cost of the largest module |
| No capability probe, no fallbacks for pre-Android-7 | one documented minimum; ~90 lines of probe/fallback code avoided |
| No connection state machine, no retry classes | process-per-call has no connection to go stale; explicit `reconnect` is enough and cannot double-execute |
| Non-atomic write via stdin `cat >` | parity with SFTP `writeFile`; avoids staging dirs, GC, `readlink -f`, mode juggling |
| Keep `mapPath` | v3 deleted it, which would have broken every relative path Pi sends |
| Host-side 10-line image magic; NUL check for text | replaces `file --mime-type` with no module |
| `adb forward --no-rebind`, ownership = `forwardSpecs` | one flag prevents stealing another tool's forward; existing "forward ⇒ tools local" behaviour is kept rather than redesigned |
| No `screen`/`pull`/`push`/`install`/`pair`/root, no spike, no fake-adb | new features or test infrastructure, not part of the transport swap; each can be added later without touching this design |

## 7. Failure modes that remain (and their handling)

| Failure | Handling |
|---|---|
| `adb` missing | `runAdb` error names `$ADB` / platform-tools; tools stay usable locally until connect |
| Device unplugged mid-session | the call's stderr + `adbHint`; `reconnect` waits ≤ 30 s |
| `unauthorized` | hint to accept the prompt; no implicit waiting |
| Command exceeds timeout | device-side `timeout` (124/137) and local kill at +8 s → `timeout:N` |
| Aborted command | local `adb` killed; `shell -T` leaves nothing running (verified by v3 author; re-check in step 5) |
| Very large output | existing accumulator spills to a local file; the command timeout bounds it, same as the SSH version |
| SELinux / app-private path denial | device stderr returned verbatim |
| Forward port already used | `adb forward --no-rebind` error returned; nothing of another tool is removed |
