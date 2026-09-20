# potato-temporal-sitespeed

Example of wiring **[potato-network](https://github.com/kriakiku/potato-network)** + **[Temporal](https://temporal.io/)** + **[sitespeed.io](https://www.sitespeed.io/)** together.

A Bun Temporal worker ensures a **long-lived** PotatoNetwork sidecar per `country`/`tier` (via Podman/Docker Engine API), runs sitespeed.io through that network namespace **three times** (separate browser containers, `-n 1` each), aggregates stats like browsertime (median/mean/…), then:

1. Parse + aggregate sitespeed JSON → `potato-metrics.json` (field + `_median`/`_mean`/… suffixes; bare = median)
2. Enrich with Potato profile / baseline / catalog + DNS/TLS/HTTP/WS stats (aggregated across runs) → `potato-enrichment.json`
3. Burn a custom ASS overlay via ffmpeg (`burnPotatoOverlay`) from the median run’s video → `{browser}.potato.mp4`
4. Emit **Influx line protocol** for the main metrics
5. Run a dedicated **CPU-only** sitespeed pass (`--cpu`), emit only CPU fields
6. Optionally upload screenshot/video/HTML to S3

Treat this repo as a reference integration, not a product.

## Workflows

### `siteSpeedTestWorkflow`

Activities (visible in Temporal UI):

1. `resolveEntryUrl` — demo auth APIs (`demo.{tld}` / optional `lobby.{tld}`) **before** Potato (auth is not shaped)
2. `ensurePotatoVolume` / `ensurePotato` / `waitPotatoHealthy` / `resetPotatoStats` — reuse `potato-{COUNTRY}-{tier}` if healthy
3. `prepareSitespeedRun` — result dir, browsertime scripts, namespace/slug
4. Optional warm: `warmupSitespeedCache` (no Potato net, no video/CPU/axe/LH; soft ~2m; non-fatal)
5. Loop ×3: `resetPotatoStats` → `measureSitespeed` (`-n 1`, video, **no** `--cpu`) → `parseSitespeedMetrics` → `enrichFromPotato`
6. `aggregateMeasureRuns` — median/mean/mdev/min/p10/p90/p99/max; pick median run for artifacts
7. `burnPotatoOverlay` → `emitInfluxMetrics` → `uploadSitespeedArtifacts` (non-fatal)
8. `resetPotatoStats` → `measureSitespeedCpu` → `parseSitespeedCpuMetrics` → `emitInfluxCpuMetrics`
9. `resetPotatoStats` end — Potato container **stays up** (torn down only by refresh)

Chrome mobile emulation: **Samsung Galaxy A51/71**, `connectivity=native` (Potato shapes), Lighthouse on for measure (GPSI off), optional `cpuThrottlingRate`, `cacheMode` cold|warm. Chrome runs with `prefers-color-scheme: dark` (`blink-settings=preferredColorScheme=0`).

### `potatoRefreshWorkflow`

1. `stopAllPotatoContainers` — tear down PotatoNetwork sidecars (`potato-*`, excluding `potato-temporal-*` worker)
2. `pruneEngineResources` — remove leftover `potato-*` / `sitespeed-*` containers, unused networks/volumes (keeps the Potato data volume), dangling images, build cache, and old local result dirs (keeps 20 newest). **Does not** pull images.
3. Short-lived passthrough Potato on the shared volume → `POST /v1/catalog/refresh` + `POST /v1/baseline/probe`, then stop that container

Country sidecars are recreated lazily on the next `ensurePotato`. Use a stable workflow id (`potato-refresh`).

### `autostartWorkflow`

Short Schedule tick (manual start also works). Keeps **manual** `start-test` / `start-refresh` unchanged.

1. If any **Running** workflow on `TEMPORAL_TASK_QUEUE` other than this autostart run → complete immediately (`skipped: busy`)
2. Else read `CONFIG_PATH` (`config.json` with `{ "autostart": [...] }`) and round-robin index from `AUTOSTART_STATE_PATH`
3. When `nextIndex` points at job **0** (start of a pass, including first ever run) → `executeChild(potatoRefreshWorkflow)` and wait
4. Start `siteSpeedTestWorkflow` for that job (fire-and-forget), then write `nextIndex = (i+1) % N`

**Hot-reload:** edit `CONFIG_PATH` anytime — the worker re-reads when mtime changes (no restart). Invalid JSON → tick skipped until fixed. Index is clamped if the list shrinks.

Example ([`config.example.json`](config.example.json)):

```json
{
  "autostart": [
    {
      "metricPrefix": "lobby",
      "country": "BD",
      "tier": "typical",
      "tld": "example.com",
      "cacheMode": "cold",
      "locale": "EN",
      "currency": "EUR"
    },
    {
      "metricPrefix": "blackjack",
      "country": "BD",
      "tld": "example.com",
      "tableId": "REPLACE_WITH_TABLE_ID",
      "direct": true,
      "cacheMode": "warm"
    }
  ]
}
```

Required per autostart job: `metricPrefix`, `country`, `tld`. Optional: `tier`, `tableId`, `direct`, `cacheMode`, `locale`, `currency`, `browser`, `cpuThrottlingRate`. Top-level keys besides `autostart` are reserved for future config.

Upsert the Schedule once:

```bash
# Bind-mount the same dir as SITESPEED_RESULTS_DIR so config/state survive restarts
cp config.example.json /var/lib/potato-sitespeed-results/config.json
# edit config… (picked up on next schedule tick)

export AUTOSTART_SCHEDULE_INTERVAL=5m   # optional, default 5m
bun run start-autostart-schedule
```

Schedule id: `potato-sitespeed-autostart`. Each tick gets a unique workflow id from Temporal.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1
- [Podman](https://podman.io/) (or Docker) on the worker host
- Temporal Server (`TEMPORAL_ADDRESS`)
- Pull access to `ghcr.io/kriakiku/potato-network` and `ghcr.io/kriakiku/potato-sitespeed.io` (or build `Dockerfile.sitespeed` locally)
- Optional: VictoriaMetrics (or Influx) reachable via `INFLUX_WRITE_URL`
- Optional: S3-compatible bucket for latest screenshot/video/HTML

> Temporal TypeScript on Bun is **experimental** (SDK ≥ 1.15). Prefer a dedicated task queue.

## E2E: sitespeed CLI (CI)

Smoke on the default `ghcr.io/kriakiku/potato-sitespeed.io` image (sitespeed.io + Noto fonts) with the same `buildSitespeedBrowserArgs` + staged journey (`--multi`) as production. No Potato, no live session — catches `startsWith` / missing-script regressions.

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
| `cacheMode` | no | `cold` | `cold` (cache clear each of 3 measures) \| `warm` (slim warmup off Potato + 3 measures with shared Chrome profile) |
| `cpuThrottlingRate` | no | — | Chrome `CPUThrottlingRate` (integer ≥ 1, e.g. `4`). Unset → no CPU throttling |
| `locale` | no | — | Optional demo manager profile locale (e.g. `EN`). Unset → keep GET `/api/v2/profile` value |
| `currency` | no | — | Optional demo manager current currency (e.g. `EUR`). Unset → keep profile `balance.current` |

Each Temporal workflow runs sitespeed **three times** with **`-n 1`** (separate browser containers + Potato stats reset between). Metrics are aggregated to browsertime-style leaves (`median`, `mean`, `mdev`, `min`, `p10`, `p90`, `p99`, `max`). Influx fields: bare name = median, plus `field_median` / `field_mean` / …. A fourth pass with `--cpu` only writes CPU series.

### Warm cache

`cacheMode=warm` does **not** double-navigate inside the journey. Instead:

1. Slim sitespeed on the **default bridge** (no Potato net / MITM), shared `user-data-dir`, no video / CPU / axe / Lighthouse — fills Chrome HTTP cache (soft ~2 minute activity timeout; failure is non-fatal)
2. Three measure runs on Potato with the **same** profile + video; Potato counters reset before each run
3. After main Influx emit: one CPU-only measure on Potato (stats reset first); only CPU fields are written

`cacheMode=cold` is three measure runs with `--browsertime.cacheClearRaw` each (no shared profile).

Cancel: Temporal workflow cancellation stops the in-flight sitespeed/ffmpeg container (AbortSignal → Podman stop/rm), resets Potato stats, and deletes the demo master session. Long-lived Potato containers are **not** removed on cancel (only `potatoRefreshWorkflow` stops them all).

### Entry URL

1. `POST https://demo.{tld}/api/v2/auth/token` — body `{ password, identifier }` and, when `DEMO_AUTH_AUTHENTICATOR` is set, `extra: { code }` (current TOTP)
2. `GET https://demo.{tld}/api/v2/profile` (Bearer) → build PATCH body
3. `PATCH https://demo.{tld}/api/v3/managers/profile` — `country` = workflow emulation country; optional `locale` / current `currency` from job input (otherwise keep profile values); `timeZoneOffset`, `gameSettings.ip` / `limitSettings` / `balance` from profile
4. `POST https://demo.{tld}/api/go/v1/master-sessions/start` with `{ "extend": true }` (lobby only) → read `msid` → `POST …/bulk-delete` that id (clear current session)
5. `POST https://demo.{tld}/api/go/v1/master-sessions/start` again (Bearer) for the real run  
   body `{"extend":true}` or `{"tableId":"…","extend":true}` — returns `frameUrl` + `msid`
6. If `direct=true` **and** `tableId` is set: `POST https://lobby.{tld}/api/v1/enter-table`
7. After the run (success, failure, or cancel): `POST https://demo.{tld}/api/go/v1/master-sessions/bulk-delete` with `{ "masterSessionIds": [msid] }` (re-auth; best-effort)

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
| `potato_sustainable` | _(disabled — Green Web / sustainable plugin not run)_ |
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
| `potato_overlay` | Event marker counts from Potato stats (`wsMarkers` / `apiMarkers` / shown ≤6, `firstIframeMs`); `burned` true when custom ASS was written to `{browser}.potato.mp4` |

Host tags replace the workflow `tld` apex with `{tld}` (e.g. `api.example.com` → `api.{tld}`). Query strings never appear in tags.

### Sustainable / Green Web

The sitespeed **sustainable** plugin is **off** (no `--sustainable.enable`). We do not call `api.thegreenwebfoundation.org` and do not ship/bind `url2green.json.gz`.

### Video overlay

Browsertime’s built-in timer stays **on** for `{browser}.native.mp4` (`--browsertime.videoParams.addTimer true`). Measure runs also pass `--visualElements` (largest H1 + largest image hero timings) and `--firstParty` from the workflow apex TLD (pagexray first/third-party cookie splits).

After measure (and Potato enrich), activity `burnPotatoOverlay` burns a custom ASS overlay (nav / iframe / sliding WS+API markers) via ffmpeg in the sitespeed image and writes `{browser}.potato.mp4` (`libx264 -preset ultrafast -crf 28`). The native mp4 is left unchanged. Overlay burn failure is non-fatal (native still uploads; `potato_overlay.burned` stays false). Workflow cancel mid-burn stops the ffmpeg container.

### Fullscreen tap

Each run stages a browsertime **multi journey** (`bt-measure-journey.js`, run with `--multi`) that opens the entry URL under `commands.measure` via raw Selenium `driver.get` (not `commands.navigate`, which would block on `pageCompleteCheck` first), injects CSS to hide `[data-test-id="fullScreen"]` (`display:none!important`, no wait/click), then `wait.byPageToComplete()` before `measure.stop`. Warm cache is a separate slim sitespeed pass (no Potato network) with a shared Chrome profile (see above), not an in-script pre-navigate.

Unset `INFLUX_WRITE_URL` → metrics emit is skipped (logged once).

### S3 result URLs (worker upload)

When `S3_BUCKET` + `S3_KEY` + `S3_SECRET` are set, the worker uploads from the local result tree (sitespeed does **not** talk to S3):

```text
{ARTIFACT_NAMESPACE_BASE}.{metricPrefix}.{country}.{tier}.{cacheMode}.{direct}.{isMirror}/
  chrome.native.png
  chrome.native.mp4
  chrome.potato.mp4
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
| `SITESPEED_IMAGE` | `ghcr.io/kriakiku/potato-sitespeed.io:40.0.0-plus1` | sitespeed.io plus1 + Noto fonts (Bengali etc.). Rebuild/publish via Actions → **Publish sitespeed image** (`workflow_dispatch`). Upstream base: `sitespeedio/sitespeed.io:40.0.0-plus1`. Worker installs Potato MITM CA + `ignore-certificate-errors` / `disable-quic`; Chrome also gets SwiftShader WebGPU/WebGL args |
| `SITESPEED_LIGHTHOUSE` | `true` | Set `false` to skip Lighthouse |
| `SITESPEED_RESULTS_DIR` | `/tmp/potato-sitespeed-results` | Absolute **engine-host** path; when worker is containerized, bind-mount the same path (see Local result files) |
| `CONFIG_PATH` | `{SITESPEED_RESULTS_DIR}/config.json` | Potato config JSON (`{ "autostart": [ SiteSpeedTestInput, … ] }`) |
| `AUTOSTART_STATE_PATH` | `{SITESPEED_RESULTS_DIR}/autostart-state.json` | Persisted `{ "nextIndex": N }` across container restarts |
| `AUTOSTART_SCHEDULE_INTERVAL` | `5m` | Used by `bun run start-autostart-schedule` |
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

Activity retries: **1** attempt for all activities except `resolveEntryUrl` / `deleteMasterSession` (**2**).

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
