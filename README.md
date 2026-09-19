# sitespeed Temporal worker

Bun + TypeScript Temporal worker that runs [sitespeed.io](https://www.sitespeed.io/) through a **per-run** [PotatoNetwork](https://github.com/kriakiku/potato-network) sidecar via **Podman**, then exports results to **S3** and **Graphite** (Grafana).

## What it does

### `siteSpeedTestWorkflow`

1. Ensures a shared Podman volume (`POTATO_DATA_VOLUME`) for catalog / baseline / MITM CA
2. Starts a dedicated PotatoNetwork container with `POTATONETWORK_PROFILE_COUNTRY` / `TIER` from workflow input
3. Disables PotatoNetwork crons (`POTATONETWORK_CATALOG_CRON=false`, `POTATONETWORK_BASELINE_CRON=false`)
4. Runs `sitespeedio/sitespeed.io` with `--network container:<potato>` so all traffic (including DNS) goes through PotatoNetwork
5. Mounts the shared root CA into sitespeed (`NODE_EXTRA_CA_CERTS` / Chrome cert flags)
6. Pushes metrics to Graphite under `GRAPHITE_NAMESPACE_BASE.<metricPrefix>` and HTML results to S3
7. Stops/removes the PotatoNetwork container

### `potatoRefreshWorkflow`

Starts PotatoNetwork on the same shared volume (passthrough, no country profile), then:

- `POST /v1/catalog/refresh`
- `POST /v1/baseline/probe`

Use a stable workflow id `potato-refresh` (the helper script does this) so refreshes do not overlap.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1
- [Podman](https://podman.io/) on the worker host
- Temporal Server reachable (`TEMPORAL_ADDRESS`)
- Network access to pull `ghcr.io/kriakiku/potato-network` and `sitespeedio/sitespeed.io`

> Temporal TypeScript workers on Bun are **experimental** (SDK ≥ 1.15). Prefer a dedicated task queue.

## Install

```bash
bun install
```

## Run the worker

```bash
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_TASK_QUEUE=sitespeed
# optional exports — see Environment below
bun run worker
```

## Start a speed test

```bash
bun run start-test -- \
  --metricPrefix lobby \
  --country BD \
  --tld example.com
```

With a table:

```bash
bun run start-test -- \
  --metricPrefix table \
  --country DE \
  --tier typical \
  --tableId t-123
  # add --direct to set direct=true (default false when tableId is set)
```

### Workflow input

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `metricPrefix` | yes | — | Graphite/S3 separator for product area (`lobby`, `table`, …) |
| `country` | yes | — | PotatoNetwork boot profile (e.g. `BD`) |
| `tier` | no | `typical` | `stable` \| `typical` \| `poor` |
| `tld` | yes | — | Host used in the entry URL (e.g. `example.com`) |
| `tableId` | no | — | When set, appended as query param |
| `direct` | no | `false` if `tableId` set | Ignored without `tableId` |
| `browser` | no | `chrome` | sitespeed `-b` |
| `iterations` | no | `3` | sitespeed `-n` |

### Entry URL

Resolved by a Temporal activity **before** PotatoNetwork/sitespeed start (auth traffic is not shaped):

1. `POST https://demo.{tld}/api/v2/auth/token` with `DEMO_AUTH_IDENTIFIER` / `DEMO_AUTH_PASSWORD`
2. `POST https://demo.{tld}/api/go/v1/master-sessions/start` with Bearer token  
   - body `{"extend":true}` or `{"tableId":"…","extend":true}`
3. If `direct=true` (requires `tableId`):  
   `POST https://lobby.{tld}/api/v1/enter-table` with `{sessionId: msid, tableId}`

sitespeed opens the returned `frameUrl`.

### Metric separation

Even when every test hits the same domain, Graphite keys use:

```text
{GRAPHITE_NAMESPACE_BASE}.{metricPrefix}.*
```

Example: `sitespeed.lobby.*` vs `sitespeed.table.*`. The same prefix is used as sitespeed `--slug` for S3 paths.

## Refresh catalog / baseline

```bash
bun run start-refresh
```

Schedule this on Temporal (e.g. daily) instead of PotatoNetwork internal crons.

## Environment

All configuration is via **process environment variables** (no `.env` file).

### Temporal

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Host:port |
| `TEMPORAL_NAMESPACE` | `default` | Namespace |
| `TEMPORAL_TASK_QUEUE` | `sitespeed` | Task queue |

### PotatoNetwork

| Variable | Default | Description |
|----------|---------|-------------|
| `POTATO_IMAGE` | `ghcr.io/kriakiku/potato-network:latest` | Image |
| `POTATO_DATA_VOLUME` | `potato-network-data` | Shared Podman volume name |
| `POTATONETWORK_API_TOKEN` | — | Optional Bearer token |
| `POTATONETWORK_SHAPE_EXCLUDE` | — | Comma/space CIDRs/IPs that bypass shaping+MITM (S3, Graphite, CDN, …) |

### sitespeed.io

| Variable | Default | Description |
|----------|---------|-------------|
| `SITESPEED_IMAGE` | `sitespeedio/sitespeed.io:38.0.0` | Pin a tag in production |

### Demo auth (entry URL)

| Variable | Required | Description |
|----------|----------|-------------|
| `DEMO_AUTH_IDENTIFIER` | yes (for tests) | Login / email for `demo.{tld}` token API |
| `DEMO_AUTH_PASSWORD` | yes (for tests) | Password for token API |

### S3

| Variable | Required | Description |
|----------|----------|-------------|
| `S3_BUCKET` | for upload | Bucket name |
| `S3_KEY` | for upload | Access key |
| `S3_SECRET` | for upload | Secret |
| `S3_ENDPOINT` | no | Custom endpoint (MinIO, etc.) |
| `S3_REGION` | no | Region |
| `S3_RESULT_BASE_URL` | no | Public base URL for Grafana links |

### Graphite

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAPHITE_HOST` | — | If unset, Graphite export is skipped |
| `GRAPHITE_PORT` | `2003` | Carbon plaintext port |
| `GRAPHITE_NAMESPACE_BASE` | `sitespeed` | Prefixed with `metricPrefix` |
| `GRAPHITE_AUTH` | — | Optional `user:password` |

Put Graphite/S3 addresses (or their CIDRs) into `POTATONETWORK_SHAPE_EXCLUDE` so result upload is not shaped/MITM’d.

## Local Temporal (optional)

```bash
temporal server start-dev
```

## Docker

Image is published to GHCR on every push to `main` (and on `v*` tags):

```text
ghcr.io/kriakiku/potato-temporal-sitespeed:latest
```

The worker needs a **host Podman socket** to start PotatoNetwork / sitespeed sidecars:

```bash
podman run --rm -d \
  --name potato-temporal-sitespeed \
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -e TEMPORAL_ADDRESS=temporal:7233 \
  -e TEMPORAL_TASK_QUEUE=sitespeed \
  -e GRAPHITE_HOST=graphite \
  -e S3_BUCKET=… -e S3_KEY=… -e S3_SECRET=… \
  ghcr.io/kriakiku/potato-temporal-sitespeed:latest
```

Build locally:

```bash
podman build -t potato-temporal-sitespeed .
```

## Dependabot

Weekly Dependabot updates (Bun deps, GitHub Actions, Docker base images). After the **CI** workflow succeeds on a Dependabot PR, **Dependabot auto-merge** squash-merges it automatically.

## Layout

```text
src/
  worker.ts                 # Worker process
  start-test.ts             # CLI to start siteSpeedTestWorkflow
  start-refresh.ts          # CLI to start potatoRefreshWorkflow
  workflows/index.ts
  activities/               # Podman + Potato API + sitespeed
  shared/                   # Workflow-safe helpers (URL, types, namespace)
  lib/                      # env + podman wrapper
.github/workflows/publish.yml
Dockerfile
```
