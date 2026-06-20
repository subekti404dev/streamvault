# StreamVault — Code Review: Bugs & Issues

> Tanggal: 20 Juni 2026 · Reviewer: Pi Agent

---

### Status Update

| Bug | Status | Catatan |
|-----|--------|---------|
| #4 docker/Dockerfile | ✅ Fixed | File sudah dihapus |
| #5 static_files.rs | ✅ Fixed | File sudah dihapus |
| #8 aria2c timeout | ✅ Fixed | Pipeline udah migrasi ke transmission-cli |
| #15 AAC 5.1 → stereo | ✅ Fixed | `-ac 2` ditambahkan ke ffmpeg di pipeline |

### New Bugs

#### 15. AAC 5.1 → Browser MSE Buffer Append Error (pipeline)

**Bug**: FFmpeg di GHA workflow tidak pake `-ac 2`, jadi audio AAC di-encode dengan channel layout asli (surround 5.1). Browser MSE (`SourceBuffer`) cuma support AAC stereo (max 2 channel).

**Dampak**: Segmen download OK, tapi browser nolak append ke SourceBuffer → `bufferAppendError` fatal. Player non-browser (VLC, ffplay) tetap jalan karena punya decoder native.

**Fix**: Pipeline ffmpeg: `-c:a aac` → `-c:a aac -ac 2 -b:a 128k` (baris 244).

**Encode baru**: ✅ Otomatis stereo.
**Encode lama**: ❌ Perlu re-trigger pipeline (`skip_download=true`) untuk re-encode ke stereo.

---

## 🔴 Critical Bugs

### 1. SQL Injection di `update_job_checkpoint` (backend/src/db/queries.rs:106-114)

**Bug**: Nilai `checkpoint` dari callback interpolasi langsung ke SQL tanpa parameter binding.

```rust
// ❌ Rentan SQL injection
let sql = format!(
    "UPDATE jobs SET last_checkpoint = '{}', status = 'checkpoint_{}', updated_at = datetime('now') WHERE id = ?",
    checkpoint, checkpoint
);
sqlx::query(&sql).bind(id).execute(pool).await?;
```

**Dampak**: Attacker bisa kirim callback dengan `checkpoint` malicious yang memanipulasi database.

**Fix**: Pake whitelist atau parameter binding:

```rust
sqlx::query(
    "UPDATE jobs SET last_checkpoint = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
)
.bind(checkpoint)
.bind(format!("checkpoint_{}", checkpoint))
.bind(id)
.execute(pool).await?;
```

---

### 2. SSE Events Tidak Pernah Sampai ke Frontend (events.ts + SseEvent serialization)

**Bug**: Ada **dua masalah** yang bikin SSE events tidak diproses frontend:

**Masalah A — Tagged enum overlap**: Rust `SseEvent` pake `#[serde(tag = "type", content = "data")]`, jadi data JSON yang dikirim:

```json
{"type":"JobCreated","data":{"job_id":"abc","title":"Toy Story 2"}}
```

Frontend di `events.ts` line 47:

```javascript
const data = JSON.parse(e.data);  // { type: "JobCreated", data: { job_id: "abc" } }
const event = { type, ...data };   // ❌ spread overwrites 'type' dengan "JobCreated"
```

`event.type` jadi `"JobCreated"` (capitalized), bukan `"job_created".`

**Masalah B — Nama event tidak match**: Semua listener (QueuePage, JobDetailPage) check `event.type` pake lowercase `'job_created'` dll, yang gak akan pernah match karena terbaca "JobCreated" dari serde tag.

**Dampak**: Queue & JobDetail page tidak auto-refresh saat ada SSE event. User harus reload manual.

**Fix**: Ubah frontend events.ts untuk extract nested `data` field:

```javascript
const raw = JSON.parse(e.data);
const event = { type, data: raw.data, ...raw.data };
```

Atau ubah Rust side untuk kirim data langsung tanpa tag (manual serialize).

---

### 3. `meta_handler` Silent Swallow Error (backend/src/stremio/routes.rs:47)

**Bug**: `unwrap_or_default()` dipanggil di `Result`, bukan `Option`:

```rust
let cached = queries::get_cached_meta(&state.db, &imdb_id, &type_).await
    .unwrap_or_default();  // ❌ swallows DB errors silently
```

`get_cached_meta` returns `AppResult<Option<CinemetaCache>>`. `unwrap_or_default()` pada `Result` akan return `Default::default()` (= `None`) saat error, tanpa logging.

**Dampak**: Kalo DB bermasalah, meta handler return empty metas tanpa error log.

**Fix**: Pake `.await?` trus `.unwrap_or(None)` atau log error:

```rust
let cached = match queries::get_cached_meta(&state.db, &imdb_id, &type_).await {
    Ok(c) => c,
    Err(e) => {
        tracing::warn!("Cinemeta cache fetch failed: {}", e);
        None
    }
};
```

---

### 4. `docker/Dockerfile` Stale & Outdated (docker/Dockerfile)

**Bug**: File `docker/Dockerfile` masih pake `rust:1.79-slim` yang udah deprecated. File ini juga udah digantikan sama `Dockerfile` di root, tapi masih ada di repo.

**Dampak**: Kalo seseorang build pake `docker/Dockerfile`, bakal gagal (sama seperti error sebelumnya — edition2024 not supported).

**Fix**: Hapus file `docker/Dockerfile` — udah gak dipake.

**Status**: ✅ Fixed (file sudah dihapus).

---

## 🟠 Medium Bugs

### 5. `static_files.rs` Dead Code (backend/src/api/static_files.rs)

**Bug**: Seluruh file `static_files.rs` tidak pernah dipanggil. Fallback service udah langsung di `app.rs`.

```rust
// app.rs fallback:
.fallback_service(tower_http::services::ServeDir::new(&dashboard_dir))
```

**Dampak**: Dead code yang bikin bingung.

**Fix**: Hapus file dan modulenya dari `api/mod.rs`.

**Status**: ✅ Fixed (file sudah dihapus).

---

### 6. Duplicate Env Read: `STREAMVAULT_DASHBOARD_DIR` (backend/src/app.rs:42-43)

**Bug**: `app.rs` baca env var langsung, padahal udah ada di `config.rs`:

```rust
// app.rs — duplikat
let dashboard_dir = std::env::var("STREAMVAULT_DASHBOARD_DIR")
    .unwrap_or_else(|_| "dashboard/dist".to_string());
```

Padahal config udah punya `config.dashboard_dir`.

**Dampak**: Konfigurasi terpecah antara dua tempat. Bisa不一致 kalo dirubah di satu tempat aja.

**Fix**: Pake `state.config.read().await.dashboard_dir.clone()` (tapi perlu Arc state). Alternatif: pake closure atau simpan di AppState langsung.

---

### 7. `gh_artifact_id_dl` / `gh_artifact_id_tc` Tidak Pernah Disimpan

**Bug**: Di `update_job_checkpoint` (queries.rs:106-114), variabel `_artifact_col` di-assign tapi tidak digunakan:

```rust
let _artifact_col = match checkpoint {
    "download" => "gh_artifact_id_dl",
    "transcode" => "gh_artifact_id_tc",
    _ => return Ok(()),
};
```

Preview `_` artinya Rust compiler tau ini sengaja diabaikan. Tujuan aslinya mungkin buat nyimpen artifact ID dari GitHub Actions, tapi gak diimplementasi.

**Dampak**: Kolom `gh_artifact_id_dl` dan `gh_artifact_id_tc` di DB selalu NULL.

**Fix**: Implementasi penyimpanan artifact ID atau hapus kolom dari DB schema.

---

### 8. ~~`aria2c` Timeout — No Timeout Config~~ ✅ Fixed

**Bug**: Pipeline dulu pake aria2c tanpa timeout. Udah diganti transmission-cli yang handle timeout & retry bawaan (via `monitor-transmission.sh`).

---
### 9. Upload Script Gagal Total Jika 1 File Gagal (upload-to-discord.sh)

**Bug**: Di `upload-to-discord.sh`, kalo upload satu file gagal setelah semua retry, script cuma log error tapi lanjut ke file berikutnya. Tapi karena pake `set -e`, error dari `callback` bisa terminate script.

```bash
set -e
# ...
callback "progress" "{\"phase\":\"upload\",...}"  # ❌ kalo curl gagal, set -e terminate script
```

**Dampak**: Pipeline gagal total kalo 1 file doang yang gagal upload ke Discord.

**Fix**: Hapus `set -e` atau tangani error di callback:

```bash
callback "progress" "..." || echo "Progress callback failed (non-fatal)" >&2
```

---

## 🟡 Minor Issues / Code Quality

### 10. `CinemetaCache` Missing `Default` Derive

Meskipun kompilasi beres karena `Result::unwrap_or_default()` pake `Default` dari `Option`, ada baiknya tambah `#[derive(Default)]` di `CinemetaCache` untuk eksplisit.

### 11. Hardcoded `dashboard/dist` Fallback

Di `config.rs` default dashboard_dir adalah `dashboard/dist` (relative). Tapi di Docker entrypoint, `STREAMVAULT_DASHBOARD_DIR=/app/dashboard`. Ini konsisten cuman kalo jalan lokal (non-Docker), mungkin perlu absolute path.

### 12. SQL Column Name Injection (Low Risk)

Di `update_job_progress` (queries.rs:88-93), nama kolom diinterpolasi dari `phase`:

```rust
let col = match phase {
    "transcode" => "transcode_pct",
    "upload" => "upload_pct",
    _ => "progress_pct",
};
```

Ini aman karena pake whitelist match. Tapi perlu diingat kalo mau nambah phase baru, harus update match ini juga.

### 13. Svelte 5 `$props()` — Toast Mutasi Langsung

Di `Toast.svelte`, komponen mutasi prop `toasts` langsung:

```svelte
function dismiss(id: number) {
    toasts = toasts.filter(t => t.id !== id);  // ❌ mutasi prop di child
}
```

Di Svelte 5, `$props()` sebaiknya readonly. Ini jalan karena `toasts` passing by reference dari App.svelte, tapi bisa jadi masalah kalo pake Svelte 5 strict mode.

**Fix**: Pake callback `onDismiss` prop.

---

### 14. `window.__addToast` Global Leak

Di `App.svelte`:

```typescript
(window as any).__addToast = addToast;
```

Ini nge-leak function ke global scope tanpa prefix atau dokumentasi. Kalau gak kepake, sebaiknya dihapus.

---

## Ringkasan

| Level | Jumlah | Keterangan |
|-------|--------|------------|
| 🔴 Critical | 4 (1 fixed) | SQL injection, SSE broken, silent error, stale Dockerfile ✅ |
| 🟠 Medium | 5 (2 fixed) | Dead code ✅, aria2c timeout ✅, duplicate config, unused columns, script brittle |
| 🟡 Minor | 5 | AAC 5.1 ✅, missing derive, path config, global leak, prop mutation |

### Priority Fixes:

1. **SQL Injection** (#1) — keamanan, harus fix ASAP
2. **SSE Events** (#2) — frontend real-time rusak total
3. **Upload script `set -e`** (#9) — pipeline gampang gagal
