# Repository Instructions

Instructions for agents working **on** `pi-adb-remote`. Read this before changing code, and read the
matching section of `ARCHITECTURE_PLAN_adb-remote-transport.md` for the measured device facts behind
any rule quoted here.

`pi-adb-remote` makes an Android device Pi's active workspace: Pi keeps using `read`, `write`, `edit`,
`bash`, `ls`, `grep`, and `find`, and those operations run on the phone through `adb`. Everything the
package does must be true for a device that has no `bash`, no SSH, no user accounts you control, and no
guarantee that a directory listed a second ago still exists.

## Layout

| Path | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry: `adb` tool, `/adb` command, connection state machine, tool routing, config, prompt/context sections, renderers |
| `src/adb/cli.ts` | `adb` subprocess runner: argv, bounded capture, wall-clock timeout, `SIGKILL` grace, env allow-list |
| `src/adb/target.ts` | endpoint parsing and selector construction (`adb`, `adb -s <serial>`, `-t <transport id>`) |
| `src/adb/device.ts` | `adb devices`/`get-state` parsing, `ro.*` identity probe, capability probe, `METHOD_CLASS` |
| `src/adb/transport.ts` | device filesystem and shell over `exec-out`/`pull`/`push`/`install`, staging writes, forwards |
| `src/adb/exec-output.ts` | device command envelope: exit-code channel, tail buffers, spill files |
| `src/adb/mime.ts` | binary/text classification without `file --mime-type` |
| `src/shell.ts` | host-side shell selection for local `sh` invocations |
| `tests/` | offline fixture suite (the gate), `tests/live/` device suite, `tests/fixtures/fake-adb.sh` |

## Device contract — non-negotiable

1. **`adb` only, subprocess only.** No SSH, SFTP, or long-lived socket to the device. Every interaction is
   one short-lived `adb` invocation through `runAdb` with a bounded capture buffer.
2. **Never build a device shell string.** Commands travel as `subcommandArgv(device, transportSerial,
   [verb, ...args])`; the single `sh -c` wrapper is created inside `AdbTransport`, never by concatenation.
   Compound statements (`&&`, `;`, pipelines) in device paths or arguments are a defect, not a shortcut.
3. **Assume `sh`, not `bash`.** No `[[ ]]`, arrays, `timeout` long options (`-k`/`-s` short options only),
   or `file --mime-type`. Anything requiring a missing applet must be gated on `capabilities`.
4. **Quote every device path** with `quote()` (single quotes, embedded `'` handled) — the device shell
   splits on spaces.
5. **Time-bound every path**, including `exec-out`, `pull`, `push`, and `install`. A hung `exec-out` holds
   the whole transport.
6. **Device identity is `ro.serialno`**, never the transport serial (`emulator-5554`, `…adb-tls-connect…`),
   which changes across reconnects and is never persisted.
7. **Writes are staged + renamed** through `<dir>/.pi-staging` with a verified rename; stale staging files
   older than 60 minutes are collected.
8. **Routing tools at a device requires `SPIKE-4A-RESULT: ok`** in the plan file. Anything else is guidance
   only.
9. **Refuse, then explain.** Device binaries, missing endpoints, locked-screen captures, port collisions,
   and identity mismatches surface as actionable prose — never a stack trace, never a silent fallback,
   never an automatic second device or a retry that re-runs a mutating verb.
10. **Destructive device operations are gated.** `adb` never auto-uninstalls; `uninstall` requires an
    explicit user decision. `forward --remove-all` is forbidden — remove the exact spec, ours only.
11. **Pairing codes go to `stdin`.** `adb pair` reads `HOST:PORT CODE` from stdin, and exits `0` even when
    the phone rejects the code — success is decided by the words `Successfully paired`, and the code must
    never appear in argv, transcripts, config, or session entries.

## Source vocabulary

The transport is a device, not a host. User-visible strings, tool parameters, config keys, prompt
sections, session entry types, and file names must not carry SSH vocabulary:

- `grep -inw "ssh|sftp" index.ts` and `grep -rn "src/ssh|ssh2|sftp" index.ts src/` must return nothing.
- Tool parameters are `deviceCommand`, `devicePath`, `hostPath`. `remoteCommand` and `remoteCwd` are banned.
- Config lives in `adb-remote-config.json`; keys are `adbCommand`, `deviceCwd`, `forwards`, `note`,
  `imageMaxBytes`, and global `activeEndpoint`, `displayLines`, `readMaxBytes`, `readMaxLines`,
  `execMaxBytes`, `execMaxLines`, `turnMaxBytes`. Legacy `ssh*`/`remote*` keys are ignored, not migrated.
- Session entry type `pi-adb-remote-state` (version `2`); runtime cache key `__piAdbRemoteRuntimeV1`;
  prompt sections `adb_remote_connection`, `adb_remote_workspace`, `adb_remote_memory_management`.

When a measured device behavior contradicts a rule above, the device wins: record the observation as a
`V` row in the plan, then change the code and this file together.

## Testing gates

| Gate | Command | Notes |
| --- | --- | --- |
| Types | `npm run typecheck` | must exit `0`; the extension ships as TypeScript loaded by Pi |
| Offline suite | `npm test` | the CI gate; drives a scripted `tests/fixtures/fake-adb.sh`, never a real device |
| Live suite | `PI_ADB_LIVE=1 npm run test:live` | self-skips without the flag and an attached device |

- Every device-facing behavior change needs an offline test against the fixture. Extend
  `tests/fixtures/fake-adb.sh` (env-driven, argv-logging) rather than mocking transport internals.
- The live suite owns a real phone: it must leave the device clean (delete its files, remove its
  forwards, uninstall what it installed), and must fire `session_shutdown` with reason `exit` on teardown
  so no Pi temp directory or stale connection survives the run.
- Test suites run with an isolated `PI_CODING_AGENT_DIR` and private `TMPDIR`; never let a test read or
  write the real agent configuration.
- Assert on exact golden command strings (for example
  `05WAY1YE00 exec-out "sh -c 'sed -n 1,2p -- /a.txt'"`) so argument-layer regressions fail loudly.
- Documented commands are checked: `tests/docs-commands.test.ts` fails when `README.md` or
  `README.zh-CN.md` documents an action or `/adb` verb that does not exist.

## Commit convention

```text
<type>(<scope>): <description>
```

Examples:

```text
feat(adb): add wireless pairing over TLS connect
fix(transport): reject partial exec-out frames as truncated reads
docs(readme): document device routing and the adb action surface
test(cli): cover bounded capture and wall-clock kill
refactor(device): move capability probing into the identity pass
chore(deps): drop the SSH client dependencies
```

Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `style`, `revert`.
Use a concise, lowercase, imperative description and a scope naming the affected component
(`adb`, `cli`, `device`, `transport`, `exec-output`, `mime`, `routing`, `config`, `command`, `docs`, `deps`).
The conversion from the SSH transport is delivered as a single `feat(adb)` commit; do not split it.

## Versioning

- `pi-adb-remote` is a **new npm artifact**, forked from `pi-ssh-remote 0.1.15`, and its release line
  starts at `0.1.0`. Do not inherit the predecessor's version numbers or changelog rows.
- Stay on `0.1.x` for small, backward-compatible features, behavior refinements, bug fixes, and
  documentation corrections; increment the patch for those release units.
- Use a new minor line such as `0.2.0` only for a substantial feature set or a compatibility change that
  clearly warrants it. After `1.0.0`, follow Semantic Versioning.
- Never create a version-only release: every bump must correspond to a tested, user-visible release unit.

## Changelog maintenance

`CHANGELOG.md` is the canonical and complete release history for **this** artifact and follows Keep a
Changelog.

- Record every user-visible addition, behavior change, deprecation, removal, bug fix, or security fix
  under `[Unreleased]` in the same commit as the change.
- Use the `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` categories; keep `Added`,
  `Changed`, and `Fixed` in every published entry and write `None` when one has no entries.
- Record npm publication dates as `YYYY-MM-DD`; never reuse a commit date as a publication date.
- At release time, move `[Unreleased]` into the new version, recreate an empty `[Unreleased]`, and keep
  the comparison links aligned with the newest tag.
- Never claim a runtime change when a release only changed package or release metadata.

## README release index

`README.md` and `README.zh-CN.md` are concise usage guides plus a release index; they are not the full
history.

- Update both READMEs in the same release commit and keep the English and Chinese tables semantically
  aligned, each linking the matching `CHANGELOG.md` version entry.
- Every documented tool action, `/adb` verb, config key, and default must exist in `index.ts` with the
  same meaning; the docs test enforces commands, and prose numbers are verified against the constants.
- Do not duplicate the changelog, and do not document SSH-era behavior that the device transport does
  not provide.

## Release alignment

1. Finalize the version entry and publication date in `CHANGELOG.md`.
2. Update the release indexes in `README.md` and `README.zh-CN.md`.
3. Set the same version in `package.json` and `package-lock.json`.
4. Run `npm run typecheck`, `npm test`, `PI_ADB_LIVE=1 npm run test:live` against a device (or record the
   skip), `git diff --check`, and `npm pack --dry-run` (the tarball contains `index.ts`, `src/`, the two
   READMEs, `CHANGELOG.md`, `LICENSE` — never `src/ssh/`).
5. Commit the complete release unit using the commit convention.
6. Create an annotated tag `v<version>` at that commit.
7. Push the release commit and tag.
8. Publish the same version to npm and verify the registry artifact matches the repository.
9. Create a GitHub Release from that tag using the matching changelog entry as notes.
10. Verify npm version, Git commit, tag, GitHub Release, and changelog all describe the same artifact.

## Release safety

- Do not publish to npm, push release commits/tags, or create GitHub Releases unless the user explicitly
  requests a release.
- Confirm the working tree contains only intended changes before committing or publishing.
- Do not reuse, overwrite, unpublish, or retag a released version to correct metadata; publish a
  subsequent version instead.
- Never put pairing codes, access tokens, passwords, or other credentials in repository files, shell
  history, release notes, config, session entries, or chat messages.
