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

Graphite keys:

```text
{GRAPHITE_NAMESPACE_BASE}.{metricPrefix}.{country}.{tier}.{cacheMode}.{isMirror}.*
```

Example: `sitespeed.lobby.BD.typical.cold.false`

S3 / sitespeed slug: `<metricPrefix>-<country>-<tier>-<cacheMode>-<isMirror>`  
Example: `lobby-BD-typical-cold-false`

`isMirror` is **derived** (not a workflow input): `true` when workflow `tld` ≠ worker `BASE_TLD` (e.g. `BASE_TLD=example.com` + `tld=neo.com` → `true`). If `BASE_TLD` is unset, `isMirror` is always `false`.

Official sitespeed Grafana dashboards expect a shorter namespace (`base.path.slug`). This layout needs custom panels or Graphite wildcards.

### S3 result URLs for Grafana

sitespeed uploads HTML/screenshots/video under the **slug**, then a timestamp folder. The worker also sets `--copyLatestFilesToBase true` so Grafana can load the **latest** assets without knowing the timestamp.

Set `S3_RESULT_BASE_URL` to the **public HTTP(S) origin** that serves the bucket (CDN or static website) — the same value as the Grafana dashboard variable `resulturl`. Do **not** point it at the S3 API host unless that host is what browsers use.

| Piece | How we set it |
|-------|----------------|
| `resulturl` | `S3_RESULT_BASE_URL` (no trailing slash) |
| `testname` | full slug, e.g. `lobby-BD-typical-cold-false` |
| `group` | page hostname with `.` → `_` (e.g. `lobby.example.com` → `lobby_example_com`) |
| `page` | URL path with `/` → `_`; root `/` → `_` |
| `browser` | workflow `browser` (default `chrome`) |
| `connectivity` | always `native` (Potato shapes traffic; browsertime `-c native`) |
| `screenshottype` | `png` (sitespeed default) |

**Latest screenshot / video (Grafana panels):**

```text
{S3_RESULT_BASE_URL}/{slug}/{group}.{page}.{browser}.{connectivity}.png
{S3_RESULT_BASE_URL}/{slug}/{group}.{page}.{browser}.{connectivity}.mp4
```

Example (`tld=example.com`, lobby, BD, typical, cold, not mirror):

```text
https://results.example.com/lobby-BD-typical-cold-false/lobby_example_com._.chrome.native.png
```

**Full HTML report for one run** (needs the timestamp folder from the bucket listing or Graphite annotation link):

```text
{S3_RESULT_BASE_URL}/{slug}/{YYYY-MM-DD-HH-MM-SS}/index.html
```

Example:

```text
https://results.example.com/lobby-BD-typical-cold-false/2026-09-19-15-08-30/index.html
```

**Pick a run via filters:** choose the slug that matches your dimensions:

```text
{metricPrefix}-{country}-{tier}-{cacheMode}-{isMirror}
```

| Filter | Slug segment |
|--------|----------------|
| product area | `metricPrefix` (`lobby`, `table`, …) |
| country | `country` (`BD`, `DE`, …) |
| network tier | `tier` (`stable` / `typical` / `poor`) |
| cache | `cacheMode` (`cold` / `warm`) |
| mirror site | `isMirror` (`true` if `tld` ≠ `BASE_TLD`, else `false`) |

Same dimensions appear in the Graphite key before the slug segment when `addSlugToKey` is on.

**Typical 404 causes**

1. Grafana `resulturl` ≠ `S3_RESULT_BASE_URL` (or trailing-slash / `http` vs `https` mismatch).
2. `testname` is only `lobby` instead of the full slug `lobby-BD-typical-cold-false`.
3. `connectivity` set to `cable` / `3g` — our runs use `native`.
4. `group` still has dots (`lobby.example.com`) instead of underscores.
5. Bucket objects are private and `S3_RESULT_BASE_URL` is not a public/CDN front.
6. Path-style bucket: if the public URL includes the bucket name, put it in `S3_RESULT_BASE_URL` (e.g. `https://minio.example.com/my-bucket`), not only in `S3_BUCKET`.

## Environment

All config is process env (no `.env` file).

| Variable | Default | Notes |
|----------|---------|-------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `sitespeed` | |
| `POTATO_IMAGE` | `ghcr.io/kriakiku/potato-network:latest` | |
| `POTATO_DATA_VOLUME` | `potato-network-data` | Shared volume name |
| `POTATO_RULES_EXPR` | — | Absolute **engine-host** path to `rules.expr`; bind-mounted to `/data/rules.expr` (Potato hot-reloads on mtime) |
| `POTATONETWORK_API_TOKEN` | — | Optional |
| `POTATONETWORK_SHAPE_EXCLUDE` | — | Extra CIDRs/IPs; merged with auto-resolved S3/Graphite |
| `SITESPEED_IMAGE` | `sitespeedio/sitespeed.io:40.0.0-plus1` | plus1 = Lighthouse available. Worker wraps `/start.sh`, installs Potato MITM CA (system + Chrome NSS), and passes `ignore-certificate-errors` + `disable-quic` (MITM often breaks QUIC → `chrome-error://chromewebdata/`) |
| `SITESPEED_LIGHTHOUSE` | `true` | Set `false` to skip Lighthouse. Empty LH→Graphite payloads are soft-warned (do not fail the run) |
| `DEMO_AUTH_IDENTIFIER` | — | Required for tests |
| `DEMO_AUTH_PASSWORD` | — | Required for tests |
| `S3_BUCKET` / `S3_KEY` / `S3_SECRET` | — | Upload when all three set |
| `S3_ENDPOINT` / `S3_REGION` / `S3_RESULT_BASE_URL` | — | Optional; endpoint must include `http://` or `https://`. `S3_RESULT_BASE_URL` = public origin for HTML/screenshots (Grafana `resulturl`) |
| `S3_FORCE_PATH_STYLE` | `true` if `S3_ENDPOINT` set, else `false` | Path-style URLs (`endpoint/bucket/…`) instead of `bucket.endpoint` |
| `GRAPHITE_HOST` | — | Skip Graphite if unset. `127.0.0.1`/`localhost` are rewritten to the host gateway for potato netns |
| `GRAPHITE_PORT` | `2003` | |
| `GRAPHITE_NAMESPACE_BASE` | `sitespeed` | First segment of Graphite keys |
| `BASE_TLD` | — | Primary apex domain (e.g. `example.com`). When workflow `tld` differs (e.g. `neo.com`), keys use `isMirror=true`. Unset → always `false` |
| `GRAPHITE_AUTH` | — | Optional `user:password` |
| `HOST_GATEWAY` | auto | Host IPv4 as seen from containers; required if loopback Graphite/S3 and auto-detect fails |

On each Potato start the worker resolves Graphite/S3 hosts to IPv4 and appends them to `POTATONETWORK_SHAPE_EXCLUDE` so result upload is not shaped/MITM’d.

Sitespeed runs in Potato’s netns, so `GRAPHITE_HOST=127.0.0.1` would mean Potato’s own loopback. The worker rewrites loopback Graphite/S3 endpoints to `HOST_GATEWAY` (or auto-detected `host.containers.internal` / Podman bridge gateway) before passing them to sitespeed and into `SHAPE_EXCLUDE`. **Carbon must listen on that address** (e.g. `0.0.0.0:2003`), not only host loopback.

### Custom path-delay rules (`POTATO_RULES_EXPR`)

One shared expr file for every PotatoNetwork container this worker starts. Set `POTATO_RULES_EXPR` to an **absolute path on the Podman/Docker host** (the machine that owns the engine socket — not a path only inside the worker container unless that path is the same on the host).

The file is bind-mounted to `/data/rules.expr`. PotatoNetwork **hot-reloads on mtime**, so you can edit the host file while runs are in flight; no worker restart needed. Prefer in-place edits (or overwrite contents) — an atomic rename that replaces the inode can leave a stale mount.

See [PotatoNetwork path rules](https://kriakiku.github.io/potato-network/rules/).

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
  -e POTATO_RULES_EXPR=/etc/potato/rules.expr \
  -v /etc/potato/rules.expr:/etc/potato/rules.expr:ro \
  -e GRAPHITE_HOST=graphite \
  -e BASE_TLD=example.com \
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
