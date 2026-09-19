# potato-temporal-sitespeed

Example of wiring **[potato-network](https://github.com/kriakiku/potato-network)** + **[Temporal](https://temporal.io/)** + **[sitespeed.io](https://www.sitespeed.io/)** together.

A Bun Temporal worker starts a per-run PotatoNetwork sidecar (via Podman/Docker Engine API), runs sitespeed.io through that network namespace, and optionally exports results to S3 / Graphite. Treat this repo as a reference integration, not a product.

## Workflows

### `siteSpeedTestWorkflow`

1. Resolves an entry URL via demo auth APIs (`demo.{tld}` / optional `lobby.{tld}`) **before** Potato starts (auth is not shaped)
2. Ensures a shared volume for Potato catalog / baseline / MITM CA
3. Boots PotatoNetwork with `country` + `tier` from the workflow input (crons off)
4. Runs `sitespeedio/sitespeed.io:40.0.0-plus1` with `--network container:<potato>`
5. Chrome mobile emulation: **Samsung Galaxy A51/71**, `connectivity=native` (Potato shapes), Lighthouse on (GPSI off), `cacheMode` cold|warm
6. Tears down the Potato container

### `potatoRefreshWorkflow`

Passthrough Potato on the same volume → `POST /v1/catalog/refresh` + `POST /v1/baseline/probe`. Use a stable workflow id (`potato-refresh`).

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1
- [Podman](https://podman.io/) (or Docker) on the worker host
- Temporal Server (`TEMPORAL_ADDRESS`)
- Pull access to `ghcr.io/kriakiku/potato-network` and `sitespeedio/sitespeed.io`

> Temporal TypeScript on Bun is **experimental** (SDK ≥ 1.15). Prefer a dedicated task queue.

## Quick start

```bash
bun install

export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_TASK_QUEUE=sitespeed
export DEMO_AUTH_IDENTIFIER=…
export DEMO_AUTH_PASSWORD=…
bun run worker
```

Start a test (another terminal):

```bash
bun run start-test -- \
  --metricPrefix lobby \
  --country BD \
  --tld example.com \
  --cacheMode cold
```

With a table:

```bash
bun run start-test -- \
  --metricPrefix table \
  --country DE \
  --tld example.com \
  --tier typical \
  --tableId t-123 \
  --cacheMode warm
# add --direct for direct=true (default false when tableId is set)
```

Refresh Potato catalog/baseline:

```bash
bun run start-refresh
```

Optional local Temporal: `temporal server start-dev`

## Workflow input

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `metricPrefix` | yes | — | Graphite/S3 separator (`lobby`, `table`, …) |
| `country` | yes | — | Potato boot profile (e.g. `BD`) |
| `tld` | yes | — | Host for auth/entry URL (e.g. `example.com`) |
| `tier` | no | `typical` | `stable` \| `typical` \| `poor` |
| `tableId` | no | — | When set, passed into session / enter-table |
| `direct` | no | `false` if `tableId` set | Ignored without `tableId` |
| `browser` | no | `chrome` | sitespeed `-b` |
| `iterations` | no | `3` | sitespeed `-n` |
| `cacheMode` | no | `cold` | `cold` (clear cache) \| `warm` (`--preURL` then measure) |

### Entry URL

1. `POST https://demo.{tld}/api/v2/auth/token`
2. `POST https://demo.{tld}/api/go/v1/master-sessions/start` (Bearer)  
   body `{"extend":true}` or `{"tableId":"…","extend":true}`
3. If `direct=true`: `POST https://lobby.{tld}/api/v1/enter-table`

sitespeed opens the returned `frameUrl`.

Graphite keys: `{GRAPHITE_NAMESPACE_BASE}.{metricPrefix}.{cacheMode}.*`  
S3 slug: `<metricPrefix>-<cacheMode>`

## Environment

All config is process env (no `.env` file).

| Variable | Default | Notes |
|----------|---------|-------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `sitespeed` | |
| `POTATO_IMAGE` | `ghcr.io/kriakiku/potato-network:latest` | |
| `POTATO_DATA_VOLUME` | `potato-network-data` | Shared volume name |
| `POTATONETWORK_API_TOKEN` | — | Optional |
| `POTATONETWORK_SHAPE_EXCLUDE` | — | Extra CIDRs/IPs; merged with auto-resolved S3/Graphite |
| `SITESPEED_IMAGE` | `sitespeedio/sitespeed.io:40.0.0-plus1` | plus1 = Lighthouse |
| `DEMO_AUTH_IDENTIFIER` | — | Required for tests |
| `DEMO_AUTH_PASSWORD` | — | Required for tests |
| `S3_BUCKET` / `S3_KEY` / `S3_SECRET` | — | Upload when all three set |
| `S3_ENDPOINT` / `S3_REGION` / `S3_RESULT_BASE_URL` | — | Optional |
| `GRAPHITE_HOST` | — | Skip Graphite if unset |
| `GRAPHITE_PORT` | `2003` | |
| `GRAPHITE_NAMESPACE_BASE` | `sitespeed` | |
| `GRAPHITE_AUTH` | — | Optional `user:password` |

On each Potato start the worker resolves Graphite/S3 hosts to IPv4 and appends them to `POTATONETWORK_SHAPE_EXCLUDE` so result upload is not shaped/MITM’d.

## Docker

Published to GHCR on push to `main` / `v*` tags:

```text
ghcr.io/kriakiku/potato-temporal-sitespeed:latest
```

Engine socket is auto-detected (Podman first, then Docker): `/run/podman/podman.sock`, `$XDG_RUNTIME_DIR/podman/podman.sock`, `/run/user/$UID/podman/podman.sock`, then `/var/run/docker.sock` / `/run/docker.sock`.

```bash
podman run --rm -d \
  --name potato-temporal-sitespeed \
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -e TEMPORAL_ADDRESS=temporal:7233 \
  -e TEMPORAL_TASK_QUEUE=sitespeed \
  -e DEMO_AUTH_IDENTIFIER=… \
  -e DEMO_AUTH_PASSWORD=… \
  -e GRAPHITE_HOST=graphite \
  -e S3_BUCKET=… -e S3_KEY=… -e S3_SECRET=… \
  ghcr.io/kriakiku/potato-temporal-sitespeed:latest
```

```bash
podman build -t potato-temporal-sitespeed .
```

## Dependabot

Weekly updates (Bun, Actions, Docker base). After **CI** passes on a Dependabot PR, **Dependabot auto-merge** squash-merges it.

## Layout

```text
src/
  worker.ts
  start-test.ts / start-refresh.ts
  workflows/
  activities/
  shared/
  lib/
.github/workflows/
Dockerfile
```
