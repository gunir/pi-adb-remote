<!--
Agent-first English documentation for pi-adb-remote: what the extension does on an Android device, how to
route Pi's tools at it, every command and action, configuration, session behavior, safety, troubleshooting.
-->

# pi-adb-remote

**An Android device as Pi's workspace — over `adb`, not over SSH.**

[中文文档](README.zh-CN.md) · [Changelog](CHANGELOG.md)

`pi-adb-remote` turns a phone or emulator into Pi's active workspace. After connecting, Pi keeps using its
normal `read`, `write`, `edit`, `bash`, `ls`, `grep`, and `find` tools — but those operations run on the
device. Nobody wraps commands in `adb shell`, nobody copies files back and forth, and the model never has
to reason about two different shells.

```text
You:  Connect to my Pixel, open /data/local/tmp/logs, find why the last capture run failed,
      fix the config, and rerun it. Give me the log path.

Pi:   adb connect → pwd → ls logs → read the newest log → edit the config →
      run the capture again → pull the result to the PC
```

Everything runs as the shell user (`uid 2000`) with no root, no Magisk, and no app installed on the phone.

## Requirements

| Requirement | Notes |
| --- | --- |
| Pi with the extension loaded | `pi install npm:pi-adb-remote` or `~/.pi/agent/extensions/` |
| Android platform-tools | `adb` on `PATH` (`ADB` overrides the binary for tests and custom builds) |
| A device with USB debugging | or wireless debugging; pairing requires Android 11+ |
| Node.js ≥ 20 | Pi's TypeScript loader runs the extension |

## What changes when a device is connected

| Pi does | Where it lands |
| --- | --- |
| `read`, `write`, `edit` | the device filesystem, relative to the device working directory |
| `bash` | one `adb shell` invocation per command, exit codes and timeouts intact |
| `ls`, `grep`, `find` | on the device, with its own `sh`-compatible search tools |
| `!ls` (your shell `!` command) | on the device, including `cd`, which then persists |
| `adb` | the device control plane: connect, screens, files, APKs, ports, notes, memory |
| `/adb` | the same control plane for you, with tab completion |

Nothing else moves. Your PC working directory, Pi's own files, and other extensions are untouched, so a
session that flashes a build, edits an init script, and greps `logcat` never has to leave the project.

## Connect

```text
/adb                          connect the saved (active) endpoint
/adb 0A1B2C3D4E5F6            connect a serial → canonical endpoint `adb -s 0A1B2C3D4E5F6`
/adb use pixel-test           switch to a saved endpoint
/adb devices                  what adb can see
/adb pair 192.168.1.20:37021  wireless pairing (the code is typed at the prompt, never stored)
/adb status                   device, routing, cwd, limits, forwards, notes
/adb disconnect               back to the local workspace
```

Or ask Pi in plain language — the agent calls the `adb` tool:

```json
{ "action": "connect", "command": "adb -s 0A1B2C3D4E5F6" }
```

`adb` is one tool with a flat action list, so the agent sees one surface instead of several look-alikes:

| Action | Purpose |
| --- | --- |
| `connect`, `reconnect`, `disconnect` | endpoint lifecycle (never auto-selects a device) |
| `devices`, `status` | what adb sees / what this session is doing |
| `pair`, `forward`, `unforward` | wireless pairing, `localhost:<port>` into device sockets |
| `exec` | one device command with the full output envelope |
| `chdir` | persistently move the device workspace |
| `screen` | a live PNG screenshot as an image block, plus a copy on the PC |
| `pull`, `push` | device ↔ PC, including directories |
| `install`, `uninstall` | APK install and removal (`uninstall` always asks you first) |
| `note`, `memory` | endpoint note / durable per-device notes |

Device files are addressed absolutely; relative paths resolve against the device working directory.
One-off device commands take their limits from the command line:

```text
/adb exec getprop ro.build.version.release
/adb exec --timeout 120 dumpsys activity recents
/adb exec --lines 20 logcat -d -v brief
/adb exec -- grep -c . /data/local/tmp/notes.txt
```

## The device is not a Linux server

The transport is built around what `adb` actually is, and the differences are surfaced instead of hidden:

- **One `sh`, no PTY.** A command becomes `adb -s <serial> exec-out "sh -c '<argv-safe command>'"` — one
  frame, no shell string built by the caller, no PTY, no `$?` games: the exit code travels on a separate
  channel, so the shell's last word can never forge it.
- **No `bash`, no GNU utilities.** Toybox only. `timeout -k 5 -s TERM N` (short options), `sed -n 'a,bp'` for
  line ranges, `stat -L -c '%F|%a|%s'` for metadata. Missing applets are reported, not emulated.
- **Writable means `/data/local/tmp` and its subdirectories.** That is the default device workspace, and a
  session can move inside it (`/adb cd /data/local/tmp/repo`); `/sdcard` writes are reported as FUSE/SELinux
  boundaries rather than blamed on the extension.
- **Text and binary are decided by content.** A sniff of the first 8 KB plus the extension decides whether a
  file is refused as binary, truncated to a range, or streamed. Large binaries are never slurped into context.
- **Screens and APKs are handled as bytes**, never as text: `screen` returns a PNG image block that the model
  can actually look at, and a copy in the session's temporary directory on the PC.

## Safety boundaries

- **No silent device substitution.** A session is bound to a device identity (`ro.serialno`). If the
  attached device is not the one the session was saved for, the extension refuses and stops routing.
- **No mutation retry storms.** A timed-out or dropped command is reported as *unknown outcome*; only
  read-class operations are ever retried, and a reconnect is shared by a single-flight promise.
- **Nothing is uninstalled or overwritten without asking.** `uninstall` requires your confirmation;
  `push` and `pull` refuse to overwrite unless you say so.
- **Pairing codes and secrets stay out of argv**, transcripts, config, and session entries — the code goes
  to `adb pair` on stdin.
- **Output is bounded by design**: per-command byte and line budgets, a per-turn model-output budget, and a
  spill file on the PC for the complete oversized output.

## Configuration

`~/.pi/agent/adb-remote-config.json`, one entry per endpoint, created on first connect. It is machine
state, not user-editable-required: `/adb config` writes it for you.

```json
{
  "activeEndpoint": "adb -s 0A1B2C3D4E5F6",
  "endpoints": {
    "adb -s 0A1B2C3D4E5F6": {
      "adbCommand": "adb -s 0A1B2C3D4E5F6",
      "deviceCwd": "/data/local/tmp",
      "note": "test Pixel",
      "forwards": ["19000:tcp:5555"],
      "imageMaxBytes": 8388608
    }
  },
  "displayLines": 5,
  "readMaxBytes": 16384,
  "readMaxLines": 400,
  "execMaxBytes": 8192,
  "execMaxLines": 200,
  "turnMaxBytes": 32768
}
```

| Key | Scope | Default | Meaning |
| --- | --- | --- | --- |
| `activeEndpoint` | global | last connected | endpoint used by a bare `/adb` and by a new session |
| `adbCommand` | endpoint | `adb` | full selector command (`adb`, `adb -s <serial>`) |
| `deviceCwd` | endpoint | `/data/local/tmp` | persistent device working directory |
| `note` | endpoint | — | your label for the device, shown in `status` and in the device list |
| `forwards` | endpoint | none | forwards restored with each connection |
| `imageMaxBytes` | endpoint | 8 MB | largest image the `read` tool accepts (max 64 MB) |
| `displayLines` | global | 5 (max 50) | collapsed device command output |
| `readMaxBytes` / `readMaxLines` | global | 16 KB / 400 | default `read` range |
| `execMaxBytes` / `execMaxLines` | global | 8 KB / 200 | default device command output |
| `turnMaxBytes` | global | 32 KB | aggregate device output per turn (never below 1 KB per call) |

Change it through the command, which validates and saves it:

```text
/adb config                                    dump the whole configuration
/adb config note "training phone"              per-endpoint note
/adb config cwd /data/local/tmp/repo           default device directory
/adb config image-max-bytes 2097152            largest image `read` accepts
/adb config forward 19000:tcp:5555             persist a forward
/adb config display-lines 12                   collapsed output lines
/adb config read-max-bytes 65536               per-read byte budget
/adb config turn-max-bytes 65536               per-turn budget
```

## Sessions and state

| Event | Behavior |
| --- | --- |
| `/new` | inherits the live connection and routing (fresh scratch space) |
| `/fork`, `/clone` | keep the source session's device, directory, and routing |
| `/resume` | reconnects and restores the recorded directory, routing, and forwards — or refuses a different phone |
| reload | keeps the connection in-process; forwards are re-registered, not doubled |
| exit | stops forwards, removes the session scratch directory, saves the last endpoint |

Per-device notes (`/adb memory`, `adb(action="memory")`) are stored on the **PC**, keyed by device identity,
and injected into context as a device-memory section — so a note written today is available the next time
that exact phone is connected, in any project, with no host round-trip and no `scp`.

## Troubleshooting

| Message | What it means |
| --- | --- |
| `no devices/emulators found` | cable, USB debugging, or `adb devices` — the endpoint name will not conjure a device |
| `unauthorized` | accept the “Allow USB debugging” dialog on the phone |
| `device offline` | the phone is still settling; the extension polls for 5 s, then asks you to unlock and replug |
| `more than one device/emulator` | two selectors collide; `adb kill-server` and name the endpoint explicitly |
| `adb server version mismatch` | update platform-tools; the extension offers to restart the server |
| `Local port N is already forwarded or in use` | another tool owns that port — only this extension's own forwards are touched |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | signatures differ; ask the user before `adb(action="uninstall")` |
| `screencap: permission denied` / an error instead of a PNG | the screen is locked; unlock it, then retry |
| `Refusing to read device binary file as text` | correct behavior; use `pull` (or `screen` for images) |

## Development

```bash
npm run typecheck          # types
npm test                   # offline suite: a scripted fake adb, no device needed
PI_ADB_LIVE=1 npm run test:live   # optional: against a real attached device
```

The offline suite is the gate; it runs in CI with no device attached. The live suite self-skips unless both
the environment variable and a device are present, and cleans up after itself on the phone. Measured device
facts, the failure catalog, and the build order live in
[`ARCHITECTURE_PLAN_adb-remote-transport.md`](ARCHITECTURE_PLAN_adb-remote-transport.md).

## Release

| Version | Date | Highlights |
| --- | --- | --- |
| [0.1.0](CHANGELOG.md#unreleased) | in development | first `pi-adb-remote` release: Android device transport replacing the SSH workspace, device-routed file/shell/search tools, `adb` control tool and `/adb` command |

## License

MIT
