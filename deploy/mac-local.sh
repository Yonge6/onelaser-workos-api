#!/usr/bin/env bash
set -euo pipefail
workos_repo="$(cd "$(dirname "$0")/.." && pwd -P)"
case "$workos_repo" in /Volumes/DevSSD/*) ;; *) echo 'Mac integration requires a DevSSD checkout.' >&2; exit 1;; esac
workos_expected_uuid="${WORKOS_DEVSSD_VOLUME_UUID:-}"
if [[ -z "$workos_expected_uuid" && -f "$workos_repo/.runtime/mac-integration/volume.uuid" ]]; then
  workos_expected_uuid="$(cat "$workos_repo/.runtime/mac-integration/volume.uuid")"
fi
if [[ -z "$workos_expected_uuid" ]]; then echo 'Set WORKOS_DEVSSD_VOLUME_UUID to the volume approved for this project.' >&2; exit 1; fi
workos_volume_uuid="$(/usr/sbin/diskutil info -plist /Volumes/DevSSD | /usr/bin/plutil -extract VolumeUUID raw -o - -)"
if [[ "$workos_volume_uuid" != "$workos_expected_uuid" ]]; then
  echo 'Required DevSSD volume is not mounted.' >&2; exit 1
fi
export WORKOS_DEVSSD_VOLUME_UUID="$workos_expected_uuid"
workos_node_bin="${WORKOS_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$workos_node_bin" ]]; then echo 'Use Node.js 22+; set WORKOS_NODE_BIN to an existing Node executable.' >&2; exit 1; fi
workos_tmp='/Volumes/DevSSD/Caches/workos-tmp'
mkdir -p "$workos_repo/.runtime/mac-integration" "$workos_tmp"
chmod 700 "$workos_repo/.runtime/mac-integration"
chmod 700 "$workos_tmp"
# Keep Unix-domain IPC paths below macOS's short socket-path limit.
export TMPDIR="$workos_tmp"
cd "$workos_repo"
exec "$workos_node_bin" "$workos_repo/node_modules/tsx/dist/cli.mjs" tools/mac-integration.ts
