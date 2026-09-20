# potato-temporal-sitespeed

Example of wiring **[potato-network](https://github.com/kriakiku/potato-network)** + **[Temporal](https://temporal.io/)** + **[sitespeed.io](https://www.sitespeed.io/)** together.

A Bun Temporal worker starts a per-run PotatoNetwork sidecar (via Podman/Docker Engine API), runs sitespeed.io through that network namespace, writes **local JSON/HTML/media**, then the worker:

1. Parses sitespeed JSON (`analysisstorer`)
2. Enriches with Potato profile / baseline / catalog + DNS/TLS/HTTP/WS stats (+ event timeline)
3. Uploads screenshot/video/HTML optionally to S3; video keeps **browsertime’s built-in timer**
4. Emits **Influx line protocol** over HTTP to [VictoriaMetrics](https://docs.victoriametrics.com/victoriametrics/integrations/datain/) (`/write`) or any Influx-compatible endpoint

Treat this repo as a reference integration, not a product.

## Workflows

### `siteSpeedTestWorkflow`

1. Resolves an entry URL via demo auth APIs (`demo.{tld}` / optional `lobby.{tld}`) **before** Potato starts (auth is not shaped)
2. Ensures a shared volume for Potato catalog / baseline / MITM CA
3. Boots PotatoNetwork with `country` + `tier` from the workflow input (crons off)
4. Runs `sitespeedio/sitespeed.io:40.0.0-plus1` once (`-n 1`) with `--network container:<potato>`, bind-mounted result dir, `--plugins.add analysisstorer`, `--video`, `--browsertime.videoParams.addTimer true`, browsertime `--script` for first-iframe timing, and a **multi journey** that taps `[data-test-id="fullScreen"]` when present. For `cacheMode=warm`, runs a lighter warmup sitespeed first (shared Chrome `user-data-dir`), then `POST /v1/stats/reset`, then the measure run
5. Chrome mobile emulation: **Samsung Galaxy A51/71**, `connectivity=native` (Potato shapes), Lighthouse on (GPSI off), `--cpu` / `--sustainable.enable` / `--axe.enable`, optional `cpuThrottlingRate`, `cacheMode` cold|warm
6. Worker post-process: Influx metrics write + optional S3 upload (video keeps browsertime timer)
7. Tears down the Potato container

### `potatoRefreshWorkflow`

1. Pulls configured images (`POTATO_IMAGE`, `SITESPEED_IMAGE`) so floating tags like `:latest` are refreshed
2. Passthrough Potato on the shared volume → `POST /v1/catalog/refresh` + `POST /v1/baseline/probe`

Use a stable workflow id (`potato-refresh`). Does not recreate the Temporal worker container itself.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1
- [Podman](https://podman.io/) (or Docker) on the worker host
- Temporal Server (`TEMPORAL_ADDRESS`)
- Pull access to `ghcr.io/kriakiku/potato-network` and `sitespeedio/sitespeed.io`
- Optional: VictoriaMetrics (or Influx) reachable via `INFLUX_WRITE_URL`
- Optional: S3-compatible bucket for latest screenshot/video/HTML

> Temporal TypeScript on Bun is **experimental** (SDK ≥ 1.15). Prefer a dedicated task queue.

## E2E: sitespeed CLI (CI)

Smoke on the real `sitespeedio/sitespeed.io` image with the same `buildSitespeedBrowserArgs` + staged journey (`--multi`) as production. No Potato, no live session — catches `startsWith` / missing-script regressions.

```bash
bun run e2e:sitespeed-cli
```

Optional: `SITESPEED_IMAGE`, `SITESPEED_E2E_URL` (default `https://kriakiku.github.io/potato-network/`), `E2E_OUT` (default `.e2e-cli-out`), `CONTAINER_ENGINE=docker|podman`.

Runs on every CI push/PR and again before GHCR publish.

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

Not run in CI (needs a live session URL). Use `e2e:sitespeed-cli` for deploy-gate smoke.

## E2E: overlay libs (optional)

Local check of ASS layout helpers + FFmpeg burn (not used by the worker anymore). No live URL.

```bash
bun run e2e:overlay
```

Optional: `SITESPEED_IMAGE`, `CONTAINER_ENGINE`, `E2E_OUT`.

## Quick start

```bash
bun install

export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_TASK_QUEUE=sitespeed
# Optional mTLS to a remote Temporal Frontend:
# export TEMPORAL_TLS=true
# export TEMPORAL_TLS_CERT_PATH=/certs/client.pem
# export TEMPORAL_TLS_KEY_PATH=/certs/client.key
# export TEMPORAL_TLS_CA_PATH=/certs/ca.pem
# export TEMPORAL_TLS_SERVER_NAME=temporal.example.com
export DEMO_AUTH_IDENTIFIER=…
export DEMO_AUTH_PASSWORD=…
# Optional metrics / artifacts
export INFLUX_WRITE_URL=http://127.0.0.1:8428/write
# export INFLUX_WRITE_USERNAME=writer
# export INFLUX_WRITE_PASSWORD=secret
# export INFLUX_WRITE_TOKEN=…
export SITESPEED_RESULTS_DIR=/tmp/potato-sitespeed-results
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
| `metricPrefix` | yes | — | Separates product areas (`lobby`, `table`, …) — Telegraf tag + S3 prefix segment |
| `country` | yes | — | Potato boot profile (e.g. `BD`) |
| `tld` | yes | — | Host for auth/entry URL (e.g. `example.com`) |
| `tier` | no | `typical` | `stable` \| `typical` \| `poor` |
| `tableId` | no | — | When set, passed into session / enter-table |
| `direct` | no | `true` | No `tableId` → always `true` (metrics). With `tableId` → `input.direct`, default `true` (enter-table); set `false` for lobby+table |
| `browser` | no | `chrome` | sitespeed `-b` |
| `cacheMode` | no | `cold` | `cold` (cache clear, one sitespeed) \| `warm` (warmup sitespeed + Potato stats reset + measure with shared Chrome profile) |
| `cpuThrottlingRate` | no | — | Chrome `CPUThrottlingRate` (integer ≥ 1, e.g. `4`). Unset → no CPU throttling |

Sitespeed always runs with **`-n 1`**. Prefer more frequent Temporal workflows over multiple iterations in one run.

### Warm cache

`cacheMode=warm` does **not** double-navigate inside the journey (that polluted Potato stats). Instead:

1. sitespeed `-n 1` with shared `user-data-dir` under the result dir (no video / no Lighthouse) — fills Chrome HTTP cache  
2. `POST /v1/stats/reset` on Potato  
3. sitespeed `-n 1` again with the **same** profile — measure + video; Potato counters cover only this run  

`cacheMode=cold` is a single measure run with `--browsertime.cacheClearRaw`.

Cancel: Temporal workflow cancellation is supported — Potato containers are always stopped in a non-cancellable cleanup (`finally`), including when the run is cancelled mid-sitespeed.

### Entry URL

1. `POST https://demo.{tld}/api/v2/auth/token` — body `{ password, identifier }` and, when `DEMO_AUTH_AUTHENTICATOR` is set, `extra: { code }` (current TOTP)
2. `POST https://demo.{tld}/api/go/v1/master-sessions/start` (Bearer)  
   body `{"extend":true}` or `{"tableId":"…","extend":true}` — returns `frameUrl` + `msid`
3. If `direct=true` **and** `tableId` is set: `POST https://lobby.{tld}/api/v1/enter-table`
4. After the run (success, failure, or cancel): `POST https://demo.{tld}/api/go/v1/master-sessions/bulk-delete` with `{ "masterSessionIds": [msid] }` (re-auth; best-effort)

sitespeed opens the returned `frameUrl` (URL is **not** used as a Telegraf tag).

### Metric identity (no URL in path)

Artifact namespace / S3 prefix:

```text
{ARTIFACT_NAMESPACE_BASE}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}
```

Examples:

- Lobby: `sitespeed.lobby.BD.typical.cold.true.false`
- Blackjack direct: `sitespeed.blackjack.BD.typical.warm.true.false`

`isMirror` is **derived**: `true` when workflow `tld` ≠ worker `BASE_TLD`. If `BASE_TLD` is unset, always `false`.

### Influx write (VictoriaMetrics)

Worker POSTs Influx line protocol to `INFLUX_WRITE_URL` (appends `precision=ns` when missing). Auth via ENV:

```bash
export INFLUX_WRITE_URL=http://victoriametrics:8428/write
export INFLUX_WRITE_USERNAME=writer
export INFLUX_WRITE_PASSWORD=secret
# or Bearer (takes precedence over Basic):
# export INFLUX_WRITE_TOKEN=…
```

Cluster example: `http://vminsert:8480/insert/0/influx/write`.

Grafana reads VictoriaMetrics as a Prometheus datasource — no Telegraf required.

Measurements (tags include `metricPrefix`, `country`, `tier`, `cacheMode`, `direct`, `isMirror`, `browser`, `connectivity` — **not** the page URL). All sitespeed-derived series use the `potato_` prefix (`sitespeed_browsertime` was renamed to `potato_browsertime`).

| Measurement | Fields (examples) |
|-------------|-------------------|
| `potato_browsertime` | Timings / visual / CWV / CPU longTasks / heaps / `firstIframeMs`; tagged points for `cpuCategory`, `consoleName` |
| `potato_pagexray` | `requests`, `transferSize`, `contentSize`, cookies, …; tagged `contentType` / `code` |
| `potato_coach` | `score`, `performanceScore`, `bestpracticeScore`, `privacyScore`, DOM info |
| `potato_axe` | `violationsCritical` / `Serious` / `Moderate` / `Minor` |
| `potato_lighthouse` | Category scores 0–100 + `audit_first_contentful_paint` (and LCP/TBT/CLS) |
| `potato_sustainable` | `co2PerPageView`, `co2FirstParty`, `co2ThirdParty`, `totalCO2` |
| `potato_thirdparty` | `requestsTotal` / `requestsPercentage`; tagged `thirdPartyCategory` / `tool` |
| `potato_profile` | `delayMs`, Mbps, `lossPercent`, `cfRttMs`, `hostCfRttMs`, … |
| `potato_dns` | per-`domain`: `count`, `errorCount`, `latencyAvgMs`, … |
| `potato_tls_client` | MITM server handshake (includes synthetic last-mile sleep) |
| `potato_tls_upstream` | Origin TLS handshake (real path) |
| `potato_http` | per `host`+`method`+`path` (query stripped; workflow apex → `{tld}`): TTFB |
| `potato_http_duplicate` | same tags when `count > 1` (`extraCount` = duplicates beyond the first) |
| `potato_websocket` | per `host`+`path`: `started` (upgrade attempts), first-frame latency |
| `potato_http_slow` | top-5 longest HTTP start→response from Potato MITM (`rank` 1–5, scrubbed `host`/`method`/`path`, `durationMs`, `failed`) — metrics only, not on video |
| `potato_cf_cache` | per `status` tag: raw `cf-cache-status` (`HIT`, `MISS`, `DYNAMIC`, …) or `NONE` (not Cloudflare); field `count` |
| `potato_overlay` | Event marker counts from Potato stats (`wsMarkers` / `apiMarkers` / shown ≤6, `firstIframeMs`); `burned` always false (no custom ASS) |

Host tags replace the workflow `tld` apex with `{tld}` (e.g. `api.example.com` → `api.{tld}`). Query strings never appear in tags.

### Video timer

Browsertime’s built-in timer is **on** (`--browsertime.videoParams.addTimer true`). The worker does **not** burn a custom ASS overlay onto the mp4.

### Fullscreen tap

Each run stages a browsertime **multi journey** (`bt-measure-journey.js`, run with `--multi`) that navigates the entry URL under `commands.measure`, waits up to 10s for `[data-test-id="fullScreen"]` (presence gate only), then **Selenium Actions-taps the viewport center** if the marker appeared (no-op if missing). Warm cache is a separate sitespeed pass with a shared Chrome profile (see above), not an in-script pre-navigate.

Unset `INFLUX_WRITE_URL` → metrics emit is skipped (logged once).

### S3 result URLs (worker upload)

When `S3_BUCKET` + `S3_KEY` + `S3_SECRET` are set, the worker uploads from the local result tree (sitespeed does **not** talk to S3):

```text
{ARTIFACT_NAMESPACE_BASE}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}/
  chrome.native.png
  chrome.native.mp4
  index.html
```

Set `S3_RESULT_BASE_URL` to the public HTTP(S) origin for the bucket (Grafana `resulturl`).

Example:

```text
https://results.example.com/sitespeed.lobby.BD.typical.cold.true.false/chrome.native.png
```

### Local result files (share one host path)

The worker stages browsertime scripts under `SITESPEED_RESULTS_DIR`, then Podman/Docker bind-mounts that **same absolute path** into sitespeed (`-v $SITESPEED_RESULTS_DIR:/sitespeed.io`). Those paths must be the **engine host** filesystem — not a path that only exists inside the worker container.

When the Temporal worker itself runs in a container (DinD / Podman-in-Podman):

1. Pick a host directory, e.g. `/var/lib/potato-sitespeed-results`
2. Mount it into the worker at the **identical** path
3. Set `SITESPEED_RESULTS_DIR` to that path

```bash
HOST_RESULTS=/var/lib/potato-sitespeed-results
mkdir -p "$HOST_RESULTS"

podman run --rm -d \
  --name potato-temporal-sitespeed \
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -v "$HOST_RESULTS:$HOST_RESULTS" \
  -e SITESPEED_RESULTS_DIR="$HOST_RESULTS" \
  # … other -e / -v …
  ghcr.io/kriakiku/potato-temporal-sitespeed:latest
```

If the worker writes to `/tmp/...` inside its own mount namespace while the engine binds a different host path, sitespeed will fail with missing journey/script files (`bt-measure-journey.js`, etc.).

Each run lands under `{SITESPEED_RESULTS_DIR}/{slug}-{timestamp}/results/` (JSON/HTML/media).

## Environment

All config is process env (no `.env` file).

| Variable | Default | Notes |
|----------|---------|-------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Frontend gRPC `host:port` |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `sitespeed` | |
| `MAX_CONCURRENT_ACTIVITIES` | `1` | Per worker process; Potato/sitespeed runs share this slot with refresh |
| `TEMPORAL_TLS` | — | `true`/`false`. Unset → TLS on when cert/CA set, else plaintext |
| `TEMPORAL_TLS_CERT_PATH` | — | Client cert PEM (mTLS; requires `TEMPORAL_TLS_KEY_PATH`) |
| `TEMPORAL_TLS_KEY_PATH` | — | Client key PEM (mTLS; requires `TEMPORAL_TLS_CERT_PATH`) |
| `TEMPORAL_TLS_CA_PATH` | — | Optional server CA PEM |
| `TEMPORAL_TLS_SERVER_NAME` | — | Optional TLS SNI override |
| `POTATO_IMAGE` | `ghcr.io/kriakiku/potato-network:latest` | |
| `POTATO_DATA_VOLUME` | `potato-network-data` | Shared volume name |
| `POTATO_RULES_EXPR` | — | Absolute **engine-host** path to `rules.expr`; bind-mounted to `/data/rules.expr` |
| `POTATONETWORK_API_TOKEN` | — | Optional |
| `POTATONETWORK_SHAPE_EXCLUDE` | — | Extra CIDRs/IPs; merged with auto-resolved S3/Influx write host |
| `SITESPEED_IMAGE` | `sitespeedio/sitespeed.io:40.0.0-plus1` | plus1 = Lighthouse. Worker installs Potato MITM CA + `ignore-certificate-errors` / `disable-quic` |
| `SITESPEED_LIGHTHOUSE` | `true` | Set `false` to skip Lighthouse |
| `SITESPEED_MAX_ATTEMPTS` | `1` | Temporal activity retries for `runSitespeed` |
| `SITESPEED_RESULTS_DIR` | `/tmp/potato-sitespeed-results` | Absolute **engine-host** path; when worker is containerized, bind-mount the same path (see Local result files) |
| `INFLUX_WRITE_URL` | — | HTTP write URL (e.g. `http://vm:8428/write`). Skip emit if unset |
| `INFLUX_WRITE_USERNAME` / `INFLUX_WRITE_PASSWORD` | — | Optional Basic auth |
| `INFLUX_WRITE_TOKEN` | — | Optional Bearer token (wins over Basic) |
| `INFLUX_WRITE_TIMEOUT_MS` | `45000` | HTTP timeout for metric write |
| `ARTIFACT_NAMESPACE_BASE` | `sitespeed` | First segment of S3 prefix (`GRAPHITE_NAMESPACE_BASE` still accepted as alias) |
| `DEMO_AUTH_IDENTIFIER` | — | Required for tests |
| `DEMO_AUTH_PASSWORD` | — | Required for tests |
| `DEMO_AUTH_AUTHENTICATOR` | — | Optional base32 TOTP secret |
| `S3_BUCKET` / `S3_KEY` / `S3_SECRET` | — | Worker upload when all three set |
| `S3_ENDPOINT` / `S3_REGION` / `S3_RESULT_BASE_URL` | — | Optional; `S3_REGION` defaults to `us-east-1` |
| `S3_FORCE_PATH_STYLE` | `true` if `S3_ENDPOINT` set | Path-style URLs |
| `BASE_TLD` | — | Primary apex; differing workflow `tld` → `isMirror=true` |
| `HOST_GATEWAY` | auto | Host IPv4 for loopback rewrite / shape exclude |

### Temporal TLS / mTLS

Unset TLS vars → plaintext (default). For remote Frontend with mTLS:

```bash
export TEMPORAL_ADDRESS=temporal.example.com:7233
export TEMPORAL_TLS=true
export TEMPORAL_TLS_CERT_PATH=/certs/client.pem
export TEMPORAL_TLS_KEY_PATH=/certs/client.key
export TEMPORAL_TLS_CA_PATH=/certs/ca.pem   # optional
export TEMPORAL_TLS_SERVER_NAME=temporal.example.com  # optional SNI
```

Cert and key must be set together. Same ENV applies to `worker`, `start-test`, and `start-refresh`. Mount cert files into the worker container when running under Podman/Docker.

`MAX_CONCURRENT_ACTIVITIES` (default `1`) caps parallel activities **per worker process**. Two worker replicas on the same queue can still run two sitespeed jobs at once; refresh activities share the same slot.

On each Potato start the worker resolves Influx write / S3 hosts to IPv4 and appends them to `POTATONETWORK_SHAPE_EXCLUDE` so export endpoints are not shaped/MITM’d.

### Custom path-delay rules (`POTATO_RULES_EXPR`)

One shared expr file for every PotatoNetwork container this worker starts. See [PotatoNetwork path rules](https://kriakiku.github.io/potato-network/rules/).

## Docker

Published to GHCR on push to `main` / `v*` tags:

```text
ghcr.io/kriakiku/potato-temporal-sitespeed:latest
```

```bash
# Same host path for worker + engine bind (see “Local result files”)
HOST_RESULTS=/var/lib/potato-sitespeed-results
mkdir -p "$HOST_RESULTS"

podman run --rm -d \
  --name potato-temporal-sitespeed \
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -v "$HOST_RESULTS:$HOST_RESULTS" \
  -e SITESPEED_RESULTS_DIR="$HOST_RESULTS" \
  -e TEMPORAL_ADDRESS=temporal:7233 \
  -e TEMPORAL_TASK_QUEUE=sitespeed \
  -e DEMO_AUTH_IDENTIFIER=… \
  -e DEMO_AUTH_PASSWORD=… \
  -e POTATO_RULES_EXPR=/etc/potato/rules.expr \
  -v /etc/potato/rules.expr:/etc/potato/rules.expr:ro \
  -e INFLUX_WRITE_URL=http://victoriametrics:8428/write \
  -e INFLUX_WRITE_USERNAME=writer \
  -e INFLUX_WRITE_PASSWORD=secret \
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
  lib/          # influx, sitespeed-json, s3-latest, …
.github/workflows/
Dockerfile
```
