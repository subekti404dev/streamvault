# Parallel Pipeline Execution + Discord Channel Sharding

## Problem

Saat ini pipeline berjalan **serial**: scheduler trigger 1 job, tunggu selesai, baru trigger berikutnya. Upload ke Discord kena rate limit (5 POST / 5s per channel).

Ingin: **N pipeline paralel** untuk film berbeda, tanpa kena rate limit.

---

## Solusi: Hash-based Channel Sharding

1 job = 1 channel. Deterministic hash `job_id` → channel. Gak ada flag, gak ada state, gak ada lock.

## Arsitektur Baru

```
Scheduler (tick 30s)
  │
  ├─ count active jobs
  ├─ hitung available slots (MAX_CONCURRENT - active)
  └─ untuk setiap slot:
       ├─ ambil queued job
       ├─ hash(job_id) → channel_id
       ├─ simpan channel_id ke job
       └─ trigger GHA dispatch dengan discord_channel_id tersebut

CI (N runner paralel)
  └─ download → transcode → upload ke channel assigned
```

## Rate Limit Math

Discord limit per channel: **5 POST / 5s** (= 1 POST/s rata-rata).
Global bot limit: 50 POST / 1s.

```
1 pipeline upload = ~1000 chunk / 17 menit ≈ 0.98 POST/s
N channel × 1 pipeline per channel = 1 POST/s per channel ≪ 5 POST/5s
→ no rate limit collision
```

| Channel count | Max paralel CI bebas 429 | Upload time (1000 chunk) |
|:---:|:---:|:---:|
| 1 | 1 pipeline | ~17 menit |
| 3 | 3 pipeline | ~6 menit (parallel) |
| 5 | 5 pipeline | ~3.5 menit (parallel) |
| 10 | 10 pipeline | ~1.7 menit (parallel) |

Collision chance kalau pipeline > channel: hash distribusi normal, sebagian channel kebagian 2 job → peak ~2 POST/s → masih di bawah limit 5/5s. Aman.

---

## Perubahan Detail

### 1. Setting — `discord_channel_ids` array

**File**: `backend/src/db/queries.rs`
**File**: `backend/src/api/settings.rs`

Kolom `app_settings` key `discord_channel_ids` — value `"123456,789012,345678,901234,567890"`.

Backend parse jadi `Vec<String>` di trigger time.

### 2. Helper — channel picker

**File baru opsional**: `backend/src/pipeline/channel.rs`

```rust
pub fn pick_channel(job_id: &str, channels: &[String]) -> Option<String> {
    if channels.is_empty() {
        return None;
    }
    // Jenkins one-at-a-time hash — fast, deterministic
    let idx = job_id.bytes().fold(0u64, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(b as u64)
    });
    Some(channels[idx as usize % channels.len()].clone())
}
```

Deterministic: job yang sama selalu pilih channel sama. Gak perlu cleanup, gak perlu flag.

### 3. `trigger_pipeline` — pilih channel & simpan

**File**: `backend/src/pipeline/trigger.rs`

Sebelum build payload:

```rust
let discord_channel_ids = get_setting_or_env(state, "discord_channel_ids")
    .await?
    .filter(|s| !s.is_empty())
    .map(|s| s.split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>()
    );

let discord_channel = match &discord_channel_ids {
    Some(ids) => pick_channel(&job.id, ids).unwrap_or(channel_fallback),
    None => channel_fallback, // single channel jika setting belum diisi
};

// Simpan channel_id ke DB
sqlx::query("UPDATE jobs SET discord_channel_id = ? WHERE id = ?")
    .bind(&discord_channel)
    .bind(&job.id)
    .execute(&state.db).await?;
```

Payload GHA dispatch:

```json
{
  "discord_channel_id": "1234567890"
}
```

### 4. Scheduler — trigger multiple jobs

**File**: `backend/src/worker/scheduler.rs`

```rust
const MAX_CONCURRENT: usize = 5; // sama dengan channel count

pub async fn scheduler_loop(state: Arc<AppState>) {
    let mut ticker = interval(Duration::from_secs(15)); // lebih cepat
    // existing...
}

async fn scheduler_tick(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let active_statuses = [
        "processing", "downloading", "checkpoint_download",
        "transcoding", "checkpoint_transcode", "uploading",
    ];
    let active_count = queries::count_jobs_by_statuses(&state.db, &active_statuses).await?;
    let slots = MAX_CONCURRENT.saturating_sub(active_count as usize);

    for _ in 0..slots {
        if let Some(job) = queries::get_next_queued_job(&state.db).await? {
            tracing::info!("Triggering job {} (slot {}/{})", job.id, _, slots);

            queries::update_job_status(&state.db, &job.id, "processing").await?;
            queries::insert_job_event(/*...*/).await?;

            let _ = state.event_tx.send(SseEvent::JobStarted { job_id: job.id.clone() });

            match trigger::trigger_pipeline(&state, &job, false, false).await {
                Ok(run_id) => tracing::info!("Triggered GHA run {} for job {}", run_id, job.id),
                Err(e) => { /* update failed */ }
            }
        } else {
            break;
        }
    }

    broadcast_queue_update(&state).await?;
    Ok(())
}
```

### 5. `count_jobs_by_statuses` — query baru

**File**: `backend/src/db/queries.rs`

```rust
pub async fn count_jobs_by_statuses(pool: &SqlitePool, statuses: &[&str]) -> AppResult<i64> {
    let placeholders: Vec<String> = statuses.iter().enumerate()
        .map(|(i, _)| format!("${}", i + 1))
        .collect();

    // sqlx Sqlite pake ? placeholder
    let sql = format!(
        "SELECT COUNT(*) FROM jobs WHERE status IN ({})",
        vec!["?"; statuses.len()].join(",")
    );

    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for s in statuses {
        q = q.bind(s);
    }
    let count: i64 = q.fetch_one(pool).await?;
    Ok(count)
}
```

**Ponytail**: `count_jobs_by_statuses` + `list_jobs_by_statuses` mirip. Daripada buat fungsi baru, extend `list_jobs_by_statuses` jadi `list_and_count_jobs_by_statuses` — return `(Vec<Job>, i64)`. Tapi lebih sederhana query count aja.

### 6. Scheduler — remove "only one active" guard

**File**: `backend/src/worker/scheduler.rs`

Hapus early return `!active_jobs.is_empty()`. Sekarang hitung slot, jangan cuma cek ada-tidaknya.

### 7. CI Pipeline — zero change

Upload script (`upload-to-discord.sh`) sudah baca `DISCORD_CHANNEL_ID` dari env variable. Pipeline YAML sudah pass `discord_channel_id` dari input. Channel tinggal diganti di trigger time — CI gak perlu tahu.

Flow yang gak berubah:
- `.github/scripts/upload-to-discord.sh` — sama persis
- `.github/workflows/streamvault-pipeline.yml` — upload step sama
- `upload-checkpoint.sh` — sama

---

## Files Changed

| File | Perubahan |
|------|-----------|
| `backend/src/worker/scheduler.rs` | Scheduler loop: count active → hitung slot → trigger N |
| `backend/src/pipeline/trigger.rs` | Baca `discord_channel_ids` setting, hash ke 1 channel, simpan ke job |
| `backend/src/pipeline/channel.rs` (new) | `pick_channel()` function |
| `backend/src/db/queries.rs` | `count_jobs_by_statuses()` query |
| `backend/src/api/settings.rs` | Gak perlu (app_settings key-value sudah generic) |

---

## Implementation Order

1. **queries.rs** — tambah `count_jobs_by_statuses()`
2. **channel.rs** — `pick_channel()` helper
3. **trigger.rs** — baca setting `discord_channel_ids`, pilih channel, kirim ke GHA
4. **scheduler.rs** — concurrent trigger loop

---

## Rollout

1. Setting `discord_channel_ids` opsional — jika kosong, fallback ke `discord_channel_id` single
2. Default `MAX_CONCURRENT = 1` — bisa dinaikkan setelah channel siap
3. Jika `discord_channel_ids` isinya cuma 1 channel → hash tetap assign ke channel itu → behavior sama seperti sekarang
4. User cukup setting channel IDs di dashboard → paralel aktif otomatis

---

## Edge Cases

**Hash collision**: 2 job ke channel sama → sama seperti sekarang. Rate limit masih aman untuk ≤5 pipeline/channel.

**Channel dihapus**: Upload gagal → CI retry (udah ada backoff). Job `failed`, user retry → hash ke channel lain (kalo channel list di-update).

**Channel list berubah**: Hash lama tetap valid untuk job lama karena `discord_channel_id` udah tersimpan di DB. Job baru pake channel baru.

**Setting kosong**: `pick_channel` return `None` → trigger pakai `discord_channel_id` env (single channel — backward compatible).

**Runner kehabisan resource GitHub Actions**: Bukan masalah kita. GHA queue handle sendiri. Job tinggal nunggu.
