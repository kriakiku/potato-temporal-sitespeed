#!/bin/bash
# Restart the sitespeed worker when Temporal reports zero workflow pollers.
# The process can stay up after an http2 keepalive timeout and stop polling;
# systemd Restart= does not fire until the main process exits.
set -euo pipefail

CONTAINER="${POTATO_WORKER_CONTAINER:-potato-temporal-sitespeed}"
SERVICE="${POTATO_WORKER_SERVICE:-potato-worker.service}"
STATE_DIR="${POTATO_WORKER_WATCH_STATE:-/run/potato-worker-watch}"
STATE="$STATE_DIR/empty"
MIN_AGE_SEC="${POTATO_WORKER_WATCH_MIN_AGE_SEC:-120}"
MISSES_BEFORE_RESTART="${POTATO_WORKER_WATCH_MISSES:-2}"

mkdir -p "$STATE_DIR"
log() { echo "$(date -Is) $*"; }

reset() { rm -f "$STATE"; }

if ! podman container exists "$CONTAINER"; then
  reset
  exit 0
fi

running="$(podman inspect -f '{{.State.Running}}' "$CONTAINER")"
if [[ "$running" != "true" ]]; then
  reset
  exit 0
fi

started="$(podman inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
# Podman emits nanoseconds (`2026-09-24 02:31:47.103039402 +0600 +06`);
# this host's date(1) rejects that fraction.
# Drop nanoseconds and the trailing zone name (`+06`); date accepts `+0600`.
started="$(printf '%s\n' "$started" | sed -E 's/\.[0-9]+//; s/[[:space:]]+[^[:space:]]+$//')"
start_epoch="$(date -d "$started" +%s)"
now="$(date +%s)"
if (( now - start_epoch < MIN_AGE_SEC )); then
  reset
  exit 0
fi

if ! pollers="$(podman exec -w /app "$CONTAINER" bun -e '
import { Connection } from "@temporalio/client";
import { getEnv } from "./src/lib/env.ts";
import { temporalConnectionOptions } from "./src/lib/temporal-connect.ts";
const env = getEnv();
const conn = await Connection.connect(await temporalConnectionOptions(env));
try {
  const res = await conn.workflowService.describeTaskQueue({
    namespace: env.temporalNamespace,
    taskQueue: { name: env.temporalTaskQueue },
    taskQueueType: 1,
  });
  console.log(String((res.pollers ?? []).length));
} finally {
  await conn.close();
}
')"; then
  log "describeTaskQueue failed; not restarting"
  reset
  exit 0
fi

pollers="${pollers//$'\r'/}"
if [[ ! "$pollers" =~ ^[0-9]+$ ]]; then
  log "unexpected poller count: ${pollers}"
  reset
  exit 0
fi

if (( pollers > 0 )); then
  reset
  exit 0
fi

misses=0
if [[ -f "$STATE" ]]; then
  misses="$(cat "$STATE")"
fi
misses=$((misses + 1))
echo "$misses" > "$STATE"
log "workflow pollers=0 (miss ${misses}/${MISSES_BEFORE_RESTART})"
if (( misses >= MISSES_BEFORE_RESTART )); then
  reset
  log "restarting ${SERVICE}"
  systemctl restart "$SERVICE"
fi
