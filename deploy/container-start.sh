#!/usr/bin/env bash
set -euo pipefail

if [[ ! "${PORT:-10000}" =~ ^[0-9]+$ ]] || (( ${PORT:-10000} < 1024 || ${PORT:-10000} > 65535 )); then
  echo 'Invalid public listening port.' >&2
  exit 1
fi
export PORT="${PORT:-10000}"
export APP_PUBLIC_URL="${APP_PUBLIC_URL:-${RENDER_EXTERNAL_URL:-}}"
export FRONTEND_CONNECTED=true
export ALLOW_DEV_LOGIN=false SEED_DEMO=false
printf '%s\n' "'use strict';window.WORKOS_CONFIG=Object.freeze({mode:'live',apiBase:'/api'});" > /app/public/runtime-config.js
caddy validate --config /app/deploy/Caddyfile --adapter caddyfile >/dev/null

HOST=127.0.0.1 PORT=3001 node /app/build/src/server.js &
api_pid=$!
caddy run --config /app/deploy/Caddyfile --adapter caddyfile &
edge_pid=$!
cleanup() {
  kill -TERM "$api_pid" "$edge_pid" 2>/dev/null || true
  wait "$api_pid" "$edge_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
# Any child exiting restarts the whole unit; the reverse proxy cannot mask a dead API.
set +e
wait -n "$api_pid" "$edge_pid"
status=$?
set -e
if (( status == 0 )); then status=1; fi
exit "$status"
