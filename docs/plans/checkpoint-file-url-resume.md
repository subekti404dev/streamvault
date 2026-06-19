# Checkpoint File URL — CI Resume via Backend

## Problem

Pipeline memiliki 2 checkpoint: **download** (file mentah) dan **transcode** (file HLS). Jika step setelahnya gagal (misal transcode selesai → upload gagal), retry saat ini memulai dari awal karena:

- `gh_artifact_id_dl` / `gh_artifact_id_tc` hanya menyimpan nama artifact (`checkpoint-dl-{job_id}`), bukan URL download
- `actions/download-artifact@v4` hanya bisa download artifact dari run yang **sama**, bukan run sebelumnya
- `retry_job` reset status ke `queued` tanpa skip flag → pipeline trigger ulang dari download

## Solusi

Setelah setiap checkpoint, CI resolve **download URL** untuk artifact dan kirim ke backend. Backend simpan URL. Saat retry, backend kirim URL itu kembali ke CI, CI download langsung dari URL.

---

## 1. DB — tambah kolom `gh_artifact_dl_url` dan `gh_artifact_tc_url`

### File: `backend/migrations/20250617000002_checkpoint_urls.sql`

```sql
ALTER TABLE jobs ADD COLUMN gh_artifact_dl_url TEXT;
ALTER TABLE jobs ADD COLUMN gh_artifact_tc_url TEXT;
```

Update struct `Job` di `backend/src/db/queries.rs` — tambah field.

---

## 2. Backend — update `checkpoint_callback` terima `file_url`

### File: `backend/src/api/callbacks.rs`

`checkpoint_callback` sekarang accept `file_url` di body JSON:

```json
{
  "checkpoint": "download",
  "artifact_id": "checkpoint-dl-abc123",
  "file_url": "https://api.github.com/repos/.../actions/artifacts/12345/zip"
}
```

Simpan `file_url` ke kolom yang sesuai (`gh_artifact_dl_url` untuk checkpoint `download`, `gh_artifact_tc_url` untuk `transcode`).

---

## 3. Backend — `trigger_pipeline` kirim file URLs

### File: `backend/src/pipeline/trigger.rs`

Tambah parameter `checkpoint_dl_url: Option<String>` dan `checkpoint_tc_url: Option<String>`.

Tambahkan input ke GHA dispatch request:

```yaml
inputs:
  checkpoint_dl_url: {checkpoint_dl_url or ""}
  checkpoint_tc_url: {checkpoint_tc_url or ""}
```

Skip flag ditentukan dari ada/tidaknya URL.

---

## 4. Backend — `retry_job` resume dari checkpoint terakhir

### File: `backend/src/api/queue.rs`

Pada `retry_job`:

1. Baca `last_checkpoint`, `gh_artifact_dl_url`, `gh_artifact_tc_url` dari job
2. Set `skip_download = last_checkpoint == "download"` (atau jika ada file URL)
3. Set `skip_transcode = last_checkpoint == "transcode"` (atau jika ada file URL)
4. Trigger pipeline dengan flags + URLs, bukan hanya reset ke queued

---

## 5. CI — setelah upload artifact, resolve dan kirim file_url

### File: `.github/scripts/upload-checkpoint.sh` (file baru)

Script yang:
1. Upload artifact (sama seperti sekarang)
2. Panggil `gh api` untuk list artifacts dari run saat ini
3. Cari artifact by name
4. Dapatkan `id` numeric dan construct download URL
5. Panggil callback ke backend dengan `file_url`

### File: `.github/workflows/streamvault-pipeline.yml`

**Restore step** — download dari `checkpoint_dl_url` / `checkpoint_tc_url` menggunakan `curl`:

```yaml
- name: Restore download checkpoint
  if: inputs.checkpoint_dl_url != ''
  run: |
    curl -L -H "Authorization: Bearer ${{ github.token }}" \
      -o checkpoint.zip "${{ inputs.checkpoint_dl_url }}"
    unzip -o checkpoint.zip -d ./downloads/
```

---

## 6. Dashboard — UX retry dengan resume info

### File: `dashboard/src/pages/JobDetailPage.svelte`

Tambah informasi:
- "Resume from download checkpoint" atau "Resume from transcode checkpoint"
- Tampilkan file URL jika ada

### File: `dashboard/src/lib/api.ts` — no change needed, `retryJob` sudah ada

---

## Ringkasan Perubahan

| Layer | File | Perubahan |
|-------|------|-----------|
| DB | migration baru | +2 kolom |
| Backend | `queries.rs` | update struct + query |
| Backend | `callbacks.rs` | accept `file_url` |
| Backend | `trigger.rs` | pass URLs + skip flags |
| Backend | `queue.rs` | retry resume logic |
| CI | `upload-checkpoint.sh` (new) | resolve + kirim file_url |
| CI | `streamvault-pipeline.yml` | restore dari URL |
| Dashboard | `JobDetailPage.svelte` | resume info |

---

## 2 Checkpoint Flow

```
Checkpoint 1 (Download selesai)
  └─ CI upload artifact → resolve download URL → callback BE with file_url
  └─ BE simpan ke gh_artifact_dl_url, status = checkpoint_download
  └─ Jika transcode gagal:
       └─ User retry → BE trigger GHA dengan checkpoint_dl_url + skip_download=true
       └─ CI download dari URL → langsung transcode

Checkpoint 2 (Transcode selesai)
  └─ CI upload HLS artifact → resolve download URL → callback BE with file_url
  └─ BE simpan ke gh_artifact_tc_url, status = checkpoint_transcode
  └─ Jika upload gagal:
       └─ User retry → BE trigger GHA dengan kedua URL, skip_download=true, skip_transcode=true
       └─ CI download HLS → langsung upload
```
