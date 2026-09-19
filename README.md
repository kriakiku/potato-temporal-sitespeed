# potato-temporal-sitespeed

Example of wiring **[potato-network](https://github.com/kriakiku/potato-network)** + **[Temporal](https://temporal.io/)** + **[sitespeed.io](https://www.sitespeed.io/)** together.

A Bun Temporal worker starts a per-run PotatoNetwork sidecar (via Podman/Docker Engine API), runs sitespeed.io through that network namespace, and optionally exports results to S3 / Graphite. Treat this repo as a reference integration, not a product.

## Workflows

### `siteSpeedTestWorkflow`

1. Resolves an entry URL via demo auth APIs (`demo.{tld}` / optional `lobby.{tld}`) **before** Potato starts (auth is not shaped)
2. Ensures a shared volume for Potato catalog / baseline / MITM CA
3. Boots PotatoNetwork with `country` + `tier` from the workflow input (crons off)
4. Runs `sitespeedio/sitespeed.io:40.0.0-plus1` with `--network container:<potato>`
5. Chrome mobile emulation: **Samsung Galaxy A51/71**, `connectivity=native` (Potato shapes), Lighthouse on (GPSI off), `--cpu` / `--sustainable.enable` / `--axe.enable`, `cacheMode` cold|warm
6. Tears down the Potato container

### `potatoRefreshWorkflow`

1. Pulls configured images (`POTATO_IMAGE`, `SITESPEED_IMAGE`) so floating tags like `:latest` are refreshed
2. Passthrough Potato on the shared volume → `POST /v1/catalog/refresh` + `POST /v1/baseline/probe`

Use a stable workflow id (`potato-refresh`). Does not recreate the Temporal worker container itself.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1
- [Podman](https://podman.io/) (or Docker) on the worker host
- Temporal Server (`TEMPORAL_ADDRESS`)
- Pull access to `ghcr.io/kriakiku/potato-network` and `sitespeedio/sitespeed.io`

> Temporal TypeScript on Bun is **experimental** (SDK ≥ 1.15). Prefer a dedicated task queue.

## E2E: black screenshot check

Runs sitespeed through **PotatoNetwork** (same `--network container:…` + MITM CA install as production), then fails if the page screenshot is ≥ 92% near-black.

```bash
# Fresh frame URL required — #masterSessionId expires
export SITESPEED_E2E_URL='https://blackjack.winfinity.live/?language=en&tableId=…&streamId=…#masterSessionId=…'

bun run e2e:screenshot

# Optional country profile (default: passthrough)
E2E_COUNTRY=DE E2E_TIER=typical bun run e2e:screenshot

# Plain sitespeed without Potato (isolate capture vs MITM)
E2E_PLAIN=1 bun run e2e:screenshot
```

Optional env: `POTATO_IMAGE`, `SITESPEED_IMAGE`, `E2E_BLACK_THRESHOLD` (default `0.92`), `E2E_OUT` (default `.e2e-out`), `CONTAINER_ENGINE=docker|podman`.

**Interpreting results**

| Result | Likely meaning |
|--------|----------------|
| FAIL through Potato, PASS with `E2E_PLAIN=1` | Potato MITM / cert / shaping |
| FAIL with `E2E_PLAIN=1` | Chrome/Xvfb capture, expired session, or WebGL/canvas |
| sitespeed exit ≠ 0 | Page load / UrlLoadError — check container logs |

Not run in CI (needs Docker + a live session URL).

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
# add --direct=false only to force lobby+table when tableId is set (default direct=true)
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
| `direct` | no | `true` | No `tableId` → always `true` (metrics). With `tableId` → `input.direct`, default `true` (enter-table); set `false` for lobby+table |
| `browser` | no | `chrome` | sitespeed `-b` |
| `iterations` | no | `3` | sitespeed `-n` |
| `cacheMode` | no | `cold` | `cold` (clear cache) \| `warm` (`--preURL` then measure) |

Cancel: Temporal workflow cancellation is supported — Potato containers are always stopped in a non-cancellable cleanup (`finally`), including when the run is cancelled mid-sitespeed.

### Entry URL

1. `POST https://demo.{tld}/api/v2/auth/token` — body `{ password, identifier }` and, when `DEMO_AUTH_AUTHENTICATOR` is set, `extra: { code }` (current TOTP)
2. `POST https://demo.{tld}/api/go/v1/master-sessions/start` (Bearer)  
   body `{"extend":true}` or `{"tableId":"…","extend":true}`
3. If `direct=true` **and** `tableId` is set: `POST https://lobby.{tld}/api/v1/enter-table`

sitespeed opens the returned `frameUrl`.

Graphite keys (`--graphite.addSlugToKey false` — no slug segment):

```text
{GRAPHITE_NAMESPACE_BASE}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}.…
```

Examples:

- Lobby (no `tableId`, `direct` omitted → `true`): `sitespeed.lobby.BD.typical.cold.true.false.pageSummary.…`
- Blackjack direct: `sitespeed.blackjack.BD.typical.warm.true.false.pageSummary.…`

`direct` in the path is the workflow field (`true`/`false`). Without `tableId` it is always **`true`**. With `tableId` and no `direct`, it defaults to **`true`** (enter-table); pass `direct: false` for lobby+table.

`isMirror` is **derived** (not a workflow input): `true` when workflow `tld` ≠ worker `BASE_TLD` (e.g. `BASE_TLD=example.com` + `tld=neo.com` → `true`). If `BASE_TLD` is unset, `isMirror` is always `false`.

Official sitespeed Grafana dashboards expect `base.path.slug`. This layout needs custom panels (see filters below).

### Grafana dashboard variables (filters)

Create cascading **Query** variables (Graphite datasource). Refresh on dashboard load.

| Variable | Type | Query / values | Notes |
|----------|------|----------------|-------|
| `base` | Constant | `sitespeed` | = `GRAPHITE_NAMESPACE_BASE` |
| `metricPrefix` | Query | `sitespeed.*` | e.g. `lobby`, `table` |
| `country` | Query | `sitespeed.$metricPrefix.*` | e.g. `BD`, `DE` |
| `tier` | Query | `sitespeed.$metricPrefix.$country.*` | `stable` / `typical` / `poor` |
| `cacheMode` | Query | `sitespeed.$metricPrefix.$country.$tier.*` | `cold` / `warm` |
| `direct` | Query | `sitespeed.$metricPrefix.$country.$tier.$cacheMode.*` | `true` / `false` |
| `isMirror` | Query | `sitespeed.$metricPrefix.$country.$tier.$cacheMode.$direct.*` | `true` / `false` |
| `group` | Custom / Query | e.g. `lobby_example_com` | hostname, `.` → `_` (sitespeed still emits this) |
| `page` | Custom | usually `lobby` (we set `--urlAlias` = metricPrefix) | or `_` |
| `browser` | Custom | `chrome` | |
| `connectivity` | Custom | `native` | always |
| `resulturl` | Constant | `S3_RESULT_BASE_URL` | no trailing slash |
| `screenshottype` | Constant | `png` | |

**Panel metric path** (no `testname` / slug):

```text
$base.$metricPrefix.$country.$tier.$cacheMode.$direct.$isMirror.pageSummary.$group.$page.$browser.$connectivity.…
```

Example:

```text
$base.$metricPrefix.$country.$tier.$cacheMode.$direct.$isMirror.pageSummary.$group.$page.$browser.$connectivity.timings.FirstVisualChange.median
```

### S3 result URLs for Grafana

sitespeed first uploads to a staging prefix `{slug}/{timestamp}/…` (slug still used only for that temp path). After the run the worker **promotes** clean latest assets to a prefix that matches the Graphite namespace, then **deletes** the timestamp folder:

```text
{GRAPHITE_NAMESPACE_BASE}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}/
  chrome.native.png
  chrome.native.mp4
  index.html
```

Set `S3_RESULT_BASE_URL` to the public HTTP(S) origin for the bucket (Grafana `resulturl`).

**Latest screenshot / video / HTML:**

```text
{S3_RESULT_BASE_URL}/{base}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}/{browser}.{connectivity}.png
{S3_RESULT_BASE_URL}/{base}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}/{browser}.{connectivity}.mp4
{S3_RESULT_BASE_URL}/{base}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}/index.html
```

Example:

```text
https://results.example.com/sitespeed.lobby.BD.typical.cold.true.false/chrome.native.png
```

In Grafana:

```text
$resulturl/$base.$metricPrefix.$country.$tier.$cacheMode.$direct.$isMirror/$browser.$connectivity.$screenshottype
```

Hash fragments like `#masterSessionId=…` are no longer left in latest filenames (staging may still contain them briefly before promote).

**Typical 404 causes**

1. Grafana `resulturl` ≠ `S3_RESULT_BASE_URL`.
2. Old dashboards still use `testname`/slug paths — switch to the dotted namespace prefix above.
3. `connectivity` set to `cable` / `3g` instead of `native`.
4. Objects private / no public CDN in front of the bucket.
5. Path-style public URL must include the bucket name in `S3_RESULT_BASE_URL` when needed.

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
| `SITESPEED_MAX_ATTEMPTS` | `1` | Temporal activity retries for `runSitespeed` only (default **1** = no retry). Injected into the workflow bundle at worker start |
| `DEMO_AUTH_IDENTIFIER` | — | Required for tests |
| `DEMO_AUTH_PASSWORD` | — | Required for tests |
| `DEMO_AUTH_AUTHENTICATOR` | — | Optional base32 TOTP secret; when set, `auth/token` includes `extra: { code }` |
| `S3_BUCKET` / `S3_KEY` / `S3_SECRET` | — | Upload when all three set |
| `S3_ENDPOINT` / `S3_REGION` / `S3_RESULT_BASE_URL` | — | Optional; endpoint must include `http://` or `https://`. `S3_REGION` defaults to `us-east-1` for the sitespeed upload. `S3_RESULT_BASE_URL` = public origin (Grafana `resulturl`) |
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
