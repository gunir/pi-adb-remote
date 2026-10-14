# Changelog

All notable user-visible changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release dates are npm
publication dates, and versions follow this repository's pre-1.0 versioning policy documented in
`AGENTS.md`.

`pi-adb-remote` is a new artifact forked from `pi-ssh-remote 0.1.15`; its history starts at `0.1.0`, and
the SSH-era changelog deliberately does not come with it.

## [Unreleased]

### Added

- Android device transport: `read`, `write`, `edit`, `bash`, `ls`, `grep`, and `find` route to the attached
  device through `adb` subprocesses, with no SSH, SFTP, or long-lived socket involved.
- `adb` tool with a flat action surface: `connect`, `reconnect`, `devices`, `status`, `disconnect`, `pair`,
  `forward`, `unforward`, `exec`, `chdir`, `note`, `memory`, `screen`, `pull`, `push`, `install`,
  `uninstall`.
- `/adb` command with argument completion for actions, saved endpoints, `config` keys, and `exec` flags; a
  bare `/adb` connects the active endpoint and `/adb <serial>` canonicalizes to `adb -s <serial>`.
- Device routing for the `!` user shell, including `cd`, which persists the device working directory.
- `screen` action: a live PNG screenshot as an image block the model can see, plus a copy in the session's
  scratch directory on the PC.
- Wireless pairing through `adb pair` with the pairing code supplied on stdin, never in argv, transcripts, or
  configuration.
- Port forwards (`localhost:<port>` → device socket) registered per spec, listed with the device status, and
  restored on reconnect without touching other tools' forwards.
- Endpoint persistence in `~/.pi/agent/adb-remote-config.json`: device working directory, note, forwards, and
  image cap per endpoint, with the connected endpoint registered on first connect.
- Per-device memory keyed by `ro.serialno`, stored on the PC and injected as a `adb_remote_*` context section
  for that device in any project.
- Prompt sections `adb_remote_connection`, `adb_remote_workspace`, and `adb_remote_memory_management`, plus a
  routing reminder re-injected after compaction.
- Connection state machine: transient `offline`/`unauthorized` settling after a replug, a staleness pre-flight
  before the next operation, single-flight reconnect shared by concurrent callers, and read-only retry policy.
- Session resume: `/new` inherits the live connection, forks keep their source workspace, and `/resume`
  re-attaches the recorded device, directory, routing, and forwards — refusing a different phone.
- Offline test suite driven by a scripted fake `adb` (`tests/fixtures/fake-adb.sh`), covering the argument
  layer, transport, tool routing, the `adb` action surface, `/adb` completions, and the session state machine.
- Optional live device suite (`PI_ADB_LIVE=1 npm run test:live`) that self-skips without hardware and cleans
  up the phone, its forwards, and its configuration afterwards.
- Documentation for the device model, safety boundaries, configuration, and troubleshooting in `README.md`
  and `README.zh-CN.md`, and repository rules for the device contract in `AGENTS.md`.

### Changed

- All user-facing vocabulary now describes a device, not a host: `deviceCommand`, `devicePath`, `hostPath`,
  `deviceCwd`, and `adb`-prefixed configuration keys replace the SSH names, and SSH-era config keys are
  ignored instead of silently migrated.
- Device commands run as a single `exec-out` frame with the exit code on a dedicated channel; the shell's last
  word can no longer forge a success code.
- Device file writes stage through `<dir>/.pi-staging` and rename into place, collecting their own stale
  staging files; `atomic: true` skips staging.
- Command output is bounded per call (400 lines / 16 KB for reads, 200 lines / 8 KB for commands) and per turn
  (32 KB), with complete oversized output spilled to a PC file; `read` ranges are 1-indexed line numbers.
- Connect failures report the adb diagnosis and the matching recovery action instead of the first line of a
  generic failure, including the `adb sees:` device list when an endpoint is absent.
- Session state is recorded as version `2` entries keyed by device identity; version `1` (SSH) entries are
  ignored rather than misapplied.

### Removed

- The SSH transport and its dependency surface: `ssh2`, `@types/ssh2`, and `ssh-config` are gone, along with
  `~/.ssh/config` parsing, key/agent authentication, host-key prompts, and the `remote` tool and `/remote`
  command.
- Endpoint "forget" and credential handling — an ADB endpoint has no credentials to store, so the only
  per-endpoint secret in the product (a pairing code) is never persisted at all.

### Fixed

- None.
