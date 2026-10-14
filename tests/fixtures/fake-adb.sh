#!/bin/sh
# Test fixture: a host-side stand-in for the adb CLI (plan §6 step 5, offline CI gate).
#
# It recognizes the argv shapes this package builds (asserted in tests/adb-cli.test.ts) and
# replays measured device behavior: shell protocol v2 semantics (V1/V2), exec-out always rc 0
# (V3), push/pull errors on stderr with rc 1 (V6), forward collisions (V24/V25), adb client
# banners (F18). Device shell commands run under /bin/sh against $FAKE_ADB_ROOT, so
# stat/timeout/sed/head/readlink/find semantics match the toybox shapes measured on the phone.
set -u

# FAKE_ADB_LOG=<file>: records every invocation so tests can count spawns (V1).
if [ -n "${FAKE_ADB_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
fi

sub=""
for token in "$@"; do
  case "$token" in
    devices | get-state | shell | exec-out | push | pull | forward | install | uninstall | start-server | wait-for-device | connect | disconnect | pair | root | usb)
      sub="$token"
      break
      ;;
  esac
done

last=""
for token in "$@"; do last="$token"; done

# Empty-string overrides are meaningful (they emulate a device with no ro.serialno), so use
# `${VAR-default}` rather than `${VAR:-default}`.
emitted_serial="${FAKE_ADB_SERIAL-05WAY1YE00}"

emit_props() {
  printf '@identity\n%s\n' "$emitted_serial"
  printf '@fallbackIdentity\n%s\n' "${FAKE_ADB_BOOT_SERIAL-$emitted_serial}"
  printf '@model\n%s\n' "${FAKE_ADB_MODEL:-Pixel 3a}"
  printf '@product\nsargo\n'
  printf '@apiLevel\n32\n'
  printf '@release\n12\n'
  printf '@abi\narm64-v8a\n'
  printf '@buildType\nuser\n'
}

emit_caps() {
  for applet in timeout sed stat grep find; do
    printf '@%s\n/system/bin/%s\n' "$applet" "$applet"
  done
  printf '@uid\n2000\n'
  echo '@stderr' 1>&2
  exit 7
}

case "$sub" in
  start-server)
    printf '* daemon not running; starting now at tcp:5037\n' 1>&2
    printf '* daemon started successfully\n' 1>&2
    if [ -n "${FAKE_ADB_SERVER_MISMATCH:-}" ]; then
      printf '%s\n' "$FAKE_ADB_SERVER_MISMATCH" 1>&2
      exit 1
    fi
    exit 0
    ;;
  wait-for-device)
    sleep "${FAKE_ADB_WAIT_SECONDS:-0}"
    [ -n "${FAKE_ADB_WAIT_FAILS:-}" ] && exit 1
    exit 0
    ;;
  devices)
    printf 'List of devices attached\n'
    printf '%s\n' "${FAKE_ADB_DEVICES:-adb-05WAY1YE00-E1sWj7._adb-tls-connect._tcp device product:sargo model:Pixel_3a device:sargo transport_id:94}"
    exit 0
    ;;
  get-state)
    printf '%s\n' "${FAKE_ADB_STATE:-device}"
    if [ -n "${FAKE_ADB_STATE_FAILS:-}" ]; then
      printf 'adb: device %s not found\n' "'${FAKE_ADB_STATE_FAILS}'" 1>&2
      exit 1
    fi
    exit 0
    ;;
  connect)
    printf 'connected to %s\n' "$last"
    exit 0
    ;;
  pair)
    # Measured on adb 1.0.41 / 35.0.2: without the code as an argument adb prints
    # "Enter pairing code:" and reads it from stdin, and it exits 0 even when pairing failed.
    until [ $# -eq 0 ]; do a="$1"; shift; [ "$a" = pair ] && break; done
    target="${1:-}"
    code=$(head -n 1)
    printf '%s' "$code" > "$FAKE_ADB_ROOT/.fake-pair-code"
    printf 'Enter pairing code: ' 1>&2
    if [ -z "$target" ]; then
      printf 'error: missing pairing target\n' 1>&2
      exit 1
    fi
    if [ -n "${FAKE_ADB_PAIR_ERROR:-}" ]; then
      printf 'error: %s\n' "$FAKE_ADB_PAIR_ERROR" 1>&2
      exit "${FAKE_ADB_PAIR_RC:-0}"
    fi
    if [ "$code" != "${FAKE_ADB_PAIR_CODE:-12345678}" ]; then
      printf 'error: wrong pairing code, please check and try again\n' 1>&2
      exit 0
    fi
    printf 'Successfully paired to %s [transport_id=99]\n' "$target"
    exit 0
    ;;
  forward)
    if [ -n "${FAKE_ADB_FORWARD_ERROR:-}" ]; then
      printf 'adb: error: %s\n' "$FAKE_ADB_FORWARD_ERROR" 1>&2
      exit 1
    fi
    # Drop the global options and the subcommand so the forward arguments are positional.
    until [ $# -eq 0 ]; do a="$1"; shift; [ "$a" = forward ] && break; done
    [ "${1:-}" = "--no-rebind" ] && shift
    fwfile="$FAKE_ADB_ROOT/.fake-forwards"
    if [ "${1:-}" = "--list" ]; then
      [ -f "$fwfile" ] && cat "$fwfile"
      [ -n "${FAKE_ADB_FORWARDS:-}" ] && printf '%s\n' "$FAKE_ADB_FORWARDS"
      exit 0
    fi
    if [ "${1:-}" = "--remove" ]; then
      gone="${2:-}"
      if [ -f "$fwfile" ] && grep -q " ${gone} " "$fwfile"; then
        grep -v " ${gone} " "$fwfile" > "$fwfile.new" && mv "$fwfile.new" "$fwfile"
      else
        printf 'error: no such forwarding spec %s\n' "$gone" 1>&2
        exit 1
      fi
      exit 0
    fi
    local_spec="${1:-}"; remote_spec="${2:-}"
    if [ -f "$fwfile" ] && grep -q " ${local_spec} " "$fwfile"; then
      printf 'adb: error: failed to reserve port: address already in use\n' 1>&2
      exit 1
    fi
    printf '%s %s %s\n' "$emitted_serial" "$local_spec" "$remote_spec" >> "$fwfile"
    exit 0
    ;;
  install)
    if [ -n "${FAKE_ADB_TRANSFER_ERROR:-}" ]; then
      # The APK never reaches the package manager (V26): the copy itself failed.
      printf 'adb: %s\n' "$FAKE_ADB_TRANSFER_ERROR" 1>&2
      exit 1
    fi
    case "${FAKE_ADB_INSTALL_STREAM:-}" in
      dir)
        printf 'Performing Streamed Install\n'
        printf "Could not access '/data/local/tmp/sideload-x': remote couldn't create file: Is a directory\n" 1>&2
        exit 1
        ;;
      space)
        printf 'Performing Streamed Install\n'
        printf 'failed to commit install: No space left on device\n' 1>&2
        exit 1
        ;;
    esac
    printf '%s\n' "${FAKE_ADB_INSTALL_OUTPUT:-Performing Streamed Install}"
    if [ -n "${FAKE_ADB_INSTALL_FAILURE:-}" ]; then
      printf 'Failure [%s]\n' "$FAKE_ADB_INSTALL_FAILURE"
      exit 1
    fi
    printf 'Success\n'
    exit 0
    ;;
  uninstall)
    until [ $# -eq 0 ]; do a="$1"; shift; [ "$a" = uninstall ] && break; done
    [ "${1:-}" = "-k" ] && shift
    if [ -n "${FAKE_ADB_UNINSTALL_FAILURE:-}" ]; then
      printf 'Failure [%s]\n' "$FAKE_ADB_UNINSTALL_FAILURE"
      exit 1
    fi
    if [ -z "${1:-}" ]; then
      printf 'error: no package specified\n' 1>&2
      exit 1
    fi
    printf 'Success\n'
    exit 0
    ;;
  push | pull)
    # Strip the global selector options to find the two path operands.
    prev=""
    paths=""
    for token in "$@"; do
      case "$prev" in -s | -t | -H | -P) prev="$token"; continue ;; esac
      case "$token" in push | pull | -s | -t | -H | -P | -a | -d | -e) prev="$token"; continue ;; esac
      paths="$paths
$token"
      prev="$token"
    done
    src=$(printf '%s\n' "$paths" | sed -n '2p')
    dst=$(printf '%s\n' "$paths" | sed -n '3p')
    if [ -n "${FAKE_ADB_TRANSFER_ERROR:-}" ]; then
      printf 'adb: error: %s\n' "$FAKE_ADB_TRANSFER_ERROR" 1>&2
      exit 1
    fi
    if [ "$sub" = "push" ]; then
      cp -r "$src" "$dst" 2>/dev/null || { printf 'adb: error: cannot stat %s\n' "$src" 1>&2; exit 1; }
      printf '%s: 1 file pushed, 0 skipped. 2.5 MB/s (%%s bytes) in 0.001s\n' "$src" "$(stat -c %s "$dst")"
      exit 0
    fi
    cp -r "$src" "$dst" 2>/dev/null || { printf 'adb: error: remote object %s does not exist\n' "$src" 1>&2; exit 1; }
    printf '1 file pulled, 0 skipped.\n'
    exit 0
    ;;
  shell | exec-out)
    ;;
  "")
    printf 'Android Debug Bridge version 1.0.41 (fake)\n'
    exit 0
    ;;
  *)
    printf 'adb: unknown command %s\n' "$sub" 1>&2
    exit 1
    ;;
esac

# --- device shell emulation ----------------------------------------------------------------
if [ -n "${FAKE_ADB_ABSENT:-}" ]; then
  printf 'adb: device %s not found\n' "'$FAKE_ADB_ABSENT'" 1>&2
  exit 1
fi

case "$last" in
  *ro.boot.serialno*)
    emit_props
    exit 0
    ;;
  *"command -v timeout"*)
    emit_caps
    ;;
esac

# Canned `stat` answer: lets tests drive the %F vocabulary and malformed modes (V13/F21).
if [ -n "${FAKE_ADB_STAT-}" ] && printf '%s' "$last" | grep -q 'stat -L'; then
  printf '%s\n' "$FAKE_ADB_STAT"
  exit 0
fi

if [ ! -d "${FAKE_ADB_ROOT:-/}" ]; then
  printf 'adb: no such root\n' 1>&2
  exit 1
fi
cd "$FAKE_ADB_ROOT" || exit 1

# A device that will not run commands at all (offline / unauthorized mid-flight).
if [ -n "${FAKE_ADB_SHELL_ERROR:-}" ] && { [ "$sub" = "shell" ] || [ "$sub" = "exec-out" ]; }; then
  printf '%s\n' "$FAKE_ADB_SHELL_ERROR" 1>&2
  exit "${FAKE_ADB_SHELL_RC:-5}"
fi

if [ "$sub" = "exec-out" ]; then
  case "$last" in
    *screencap*\ -p*|*screencap\ -p*)
      # V31: the PNG arrives raw on stdout, with no shell v2 protocol framing.
      if [ -n "${FAKE_ADB_PNG:-}" ] && [ -f "${FAKE_ADB_PNG}" ]; then
        cat "$FAKE_ADB_PNG"
      else
        printf 'screencap: permission denied\n' 1>&2
      fi
      exit 0
      ;;
  esac
  if [ -n "${FAKE_ADB_EXEC_OUT_EMPTY:-}" ]; then
    # V3 + V34: rc 0 and not a single byte, even though `stat` promised content.
    exit 0
  fi
  /bin/sh -c "$last"
  # V3: exec-out reports success even when the device command failed.
  exit 0
fi
exec /bin/sh -c "$last"
