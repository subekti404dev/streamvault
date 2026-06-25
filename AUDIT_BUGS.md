# StreamVault Bug Audit

> **Date:** 2026-06-24
> **Scope:** Backend (Bun/Hono), Frontend (Svelte 5), CI/CD pipeline, infrastructure
> **Total findings:** 28 (5 critical, 7 high, 11 medium, 5 low)

---

## 🔴 Critical (5)

> **Fixed:** Commit `3d273a6` — BencodeParser bounds checks + string length validation.
> **Fixed:** Commit `1b04d29` — HLS proxy auth, scheduler race fix, pipeline concurrency, ffmpeg trap.
### 1. BencodeParser infinite loop — DoS via /api/v1/torrent/inspect

**File:** `backend-bun/src/api/torrent.ts:51,59,71,82`

`while` loops in `BencodeReader` (`parseInt`, `parseString`, `parseDict`, `parseList`) search for terminator bytes (`0x65`/'e', `0x3a`/':') without bounds checking the `Uint8Array` input. If a crafted torrent file is missing the expected sentinel, the loop reads past the buffer — infinite loop, 100% CPU, server hang.

**Trigger:** POST to `/api/v1/torrent/inspect` with malformed torrent data.

**Fix:** Add bounds check in `peek()`/`readByte()` — throw on `pos >= data.length`.

---

### 2. HLS proxy unauthenticated

**File:** `backend-bun/src/stremio/proxy.ts:26,67`

`playlistHandler` (serves `master.m3u8`) and `chunkHandler` (serves `.ts` segments) are registered on the public router — **no auth middleware**. Anyone who knows a `jobId` can stream any video.

**Trigger:** Access `/proxy/hls/<jobId>/master.m3u8` with any known job ID.

**Fix:** Add auth middleware or require a short-lived token parameter.

---

### 3. Scheduler race condition — duplicate job pick

**File:** `backend-bun/src/worker/scheduler.ts:72-97`

`worker()` uses `setInterval(tick, 15_000)`. If `tick()` takes longer than 15s (e.g. GitHub API is slow), two `tick()` invocations overlap. Both call `getNextQueuedJob()` and `updateJobStatus()` — same job can be picked twice. The operation isn't atomic.

**Trigger:** Multiple jobs queued, GitHub API latency spikes.

**Fix:** Replace `setInterval` with `setTimeout` recursion — schedule next tick only after current completes.

---

### 4. Pipeline workflow no concurrency guard

**File:** `.github/workflows/streamvault-pipeline.yml:1`

Missing `concurrency` group in the workflow definition. Multiple `workflow_dispatch` triggers can execute simultaneously, operating on the same job runner and corrupting state.

**Fix:** Add `concurrency: group: ${{ inputs.job_id }} cancel-in-progress: true`.

---

### 5. ffmpeg process leak on workflow cancellation

**File:** `.github/workflows/streamvault-pipeline.yml:170`

No `trap` registered for `SIGTERM`/`SIGINT`. If a workflow run is cancelled manually, `ffmpeg` continues to run in the background until the runner VM is destroyed. Orphaned processes can accumulate.

**Fix:** Add `trap 'kill $FFMPEG_PID 2>/dev/null' EXIT TERM INT` before the ffmpeg subprocess.

---

## 🟠 High (7)

### 6. Magnet URI injection into CI pipeline

**File:** `backend-bun/src/api/queue.ts:20-46`

`magnet_uri` from user input is sent directly to the `workflow_dispatch` inputs without sanitization. Arbitrary text flows into GitHub Actions workflow variables. If the pipeline uses these inputs in shell commands (even indirectly), injection is possible.

**Trigger:** POST to `/api/v1/queue` with crafted `magnet_uri`.

**Fix:** Sanitize/validate magnet URI format before dispatching to GitHub.

---

### 7. Settings endpoint can overwrite auth_secret

**File:** `backend-bun/src/api/settings.ts:88-107`

The `UPDATE /api/v1/settings` endpoint accepts a `settings` object and writes all keys to the DB via `upsertSetting`, including `auth_secret`. An attacker (or admin mistake) could:
- Change the auth secret to an empty string — all requests authorized
- Set a different secret, locking out the current admin

**Trigger:** PUT to `/api/v1/settings` with `{ auth_secret: "" }`.

**Fix:** Blacklist `auth_secret` from settings API writes, or require confirmation.

---

### 8. API client swallows HTTP errors

**File:** `dashboard/src/lib/api.ts:70-71,79-84`

`deleteJob()` and `updateSettings()` call `await fetch(...)` but never check `response.ok`. A 401, 500, or any non-2xx response is silently treated as success. The UI shows "removed"/"saved" while the operation actually failed.

**Fix:** Use `handleResponse()` like other endpoints.

---

### 9. sendNotification silent failures

**File:** `backend-bun/src/notifications/telegram.ts:76-87`

`fetch()` call has `.catch(() => {})` — every failure is silent. No log, no retry, no alert. If the Telegram API is down or the bot token is invalid, the admin is never notified.

**Fix:** Log the error at minimum; consider a retry or admin alert.

---

### 10. sendNotification unawaited in completeCallback

**File:** `backend-bun/src/api/callbacks.ts:79`

`sendNotification()` returns a `Promise<void>` but is called without `await` or `.catch()`. If the notification fails, the promise rejection is unhandled.

**Trigger:** Job completes but Telegram notification fails.

**Fix:** Add `.catch()` or `await`.

---

### 11. Scheduler cleanup leak — cannot stop timer

**File:** `backend-bun/src/worker/scheduler.ts:114-126`

`worker()` returns `() => clearInterval(timer)` for graceful shutdown, but `index.ts:104` discards the return value. The `setInterval` runs forever with no cleanup path.

**Fix:** Store the cleanup function and call it on `process.on('SIGTERM', ...)`.

---

### 12. Word splitting in upload script

**File:** `.github/scripts/upload-to-discord.sh:59-66`

```bash
FILES=$(find "$HLS_DIR" -maxdepth 1 -name "*.ts" | sort)
for file in $FILES; do
```

`$FILES` is unquoted — filenames containing whitespace are split, causing multiple iterations with invalid paths.

**Fix:** Use `while IFS= read -r file` loop pattern, or set `IFS=$'\n'`.

---

## 🟡 Medium (11)

### 13. retryJob returns wrong HTTP status

**File:** `backend-bun/src/api/queue.ts:115-122`

All errors from `retryJob` are caught and thrown as `badRequest` (HTTP 400). If `triggerPipeline` throws `internal` (500) because GitHub API is down, the caller gets 400 instead of 500 — misleading.

**Fix:** Preserve the original error type, or at minimum log the real error.

---

### 14. Bencode parseInt unbounded allocation

**File:** `backend-bun/src/api/torrent.ts:62`

```ts
const len = parseInt(lenStr, 10);
const str = new TextDecoder().decode(this.data.subarray(this.pos, this.pos + len));
```

A crafted integer like `9999999999` causes `subarray` with an enormous length — potential OOM or crash.

**Fix:** Reject lengths exceeding `data.length - pos`.

---

### 15. progress_pct unvalidated

**File:** `backend-bun/src/api/callbacks.ts:24`

```ts
const progressPct: number = body.progress_pct ?? 0;
```

No clamping to 0-100. Pipeline could send `-1`, `150`, or `NaN`.

**Fix:** Clamp `progressPct` to `[0, 100]`.

---

### 16. EventBus swallows listener errors

**File:** `backend-bun/src/api/events.ts:15-16`

```ts
try { fn(event); } catch {}
```

Every listener error is silently swallowed. If SSE delivery fails or a handler crashes, no one knows.

**Fix:** Log errors at minimum.

---

### 17. GHA cleanup not awaited

**File:** `backend-bun/src/api/callbacks.ts:86-93`

GitHub Actions run cleanup (DELETE) is fire-and-forget with `.catch()`. If it fails, the completed job's workflow run remains orphaned.

**Fix:** `await` and log failures.

---

### 18. media_type not validated

**File:** `backend-bun/src/api/search.ts:279`

Only `imdb_id` format is validated (`startsWith("tt")`). `media_type` is used directly in URL paths to Cinemeta and Torrentio — could request unexpected endpoints.

**Fix:** Validate `media_type` is `"movie"` or `"series"`.

---

### 19. curl without --max-time

**File:** `.github/scripts/upload-to-discord.sh:84`

`curl` upload has no `--max-time` option. If Discord API is slow or connection stalls, the script hangs indefinitely.

**Fix:** Add `--max-time 60` or similar.

---

### 20. stderr merged into API response

**File:** `.github/scripts/upload-to-discord.sh:84`

`2>&1` merges stderr into stdout, polluting the JSON response with diagnostic output. `jq` parsing may fail on garbage data.

**Fix:** Use separate stderr capture or `2>/dev/null` instead of `2>&1`.

---

### 21. CRF 28 degrades quality

**File:** `.github/workflows/streamvault-pipeline.yml:159`

`-crf 28` produces noticeably lower visual quality at minimal size savings. CRF 23 is the recommended balanced value.

**Fix:** Change to `-crf 23`.

---

### 22. .github/ included in Docker build context

**File:** `Dockerfile` and `.dockerignore`

The `.github/` directory (workflows, scripts, runner Dockerfile) is sent to the Docker build context, inflating build time and image layers unnecessarily.

**Fix:** Add `.github/` to `.dockerignore`.

---

### 23. docker-compose.yml hardcoded image name

**File:** `docker-compose.yml`

Default image name `yourname/streamvault` will fail for anyone who clones the repo without changing it.

**Fix:** Use descriptive placeholder or document the required change.

---

## 🟢 Low (5)

### 24. "Invalid Date" when created_at is null

**File:** `dashboard/src/pages/QueuePage.svelte:116` (and JobDetailPage)

```svelte
<span>Added {job.created_at ? new Date(job.created_at + 'Z').toLocaleString() : ''}</span>
```

When `created_at` is `null`, the ternary falls back to `''`. But when `created_at` is an invalid string, `new Date('nullZ')` renders "Invalid Date".

---

### 25. Triple API fetch on LibraryPage tab switch

**File:** `dashboard/src/pages/LibraryPage.svelte`

`$effect` reacts to state changes caused by its own side effects — fetching data updates state, which triggers the effect again, causing 2-3 API calls per tab switch.

**Fix:** Guard with a "fetching" flag or `$effect(() => { ... if (!dirty) return; })`.

---

### 26. Settings form has no client-side validation

**File:** `dashboard/src/pages/SettingsPage.svelte`

Form fields are submitted directly to the API without client-side validation. Malformed or empty values reach the backend.

**Fix:** Add basic field validation before submit.

---

### 27. Makefile dev-backend targets Rust

**File:** `Makefile`

`make dev-backend` runs `cargo run` — points to the Rust implementation, not the Bun backend that ships in Docker.

**Fix:** Rename target or add bun target.

---

### 28. gh_run_id missing from Job type

**File:** `dashboard/src/lib/types.ts`

JobDetailPage references `job.gh_run_id` but the `Job` interface doesn't declare it. Runtime-safe (TypeScript only), but hides type errors.

**Fix:** Add `gh_run_id?: string` to the `Job` type.

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 5 |
| 🟠 High | 7 |
| 🟡 Medium | 11 |
| 🟢 Low | 5 |
| **Total** | **28** |

**Key risks:**
- DoS via unauthenticated endpoint (BencodeParser infinite loop)
- Unauthorized HLS stream access (no auth on proxy routes)
- State corruption from overlapping scheduler ticks
- CI/CD pipeline race conditions and orphaned processes
- Silent failures in notifications and API client
