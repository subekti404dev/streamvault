# StreamVault — Telegram MTProto Storage (Jalur B)

Plan & spesifikasi teknis untuk menambahkan **Telegram (MTProto)** sebagai backend storage alternatif bagi HLS chunks, menggantikan/mendampingi Discord CDN.

> Status: **Diimplementasi (Bot API HTTP)** — lihat catatan keputusan di bawah. Disusun dari analisis kode StreamVault (`7af3341`).
>
> **Keputusan implementasi (2026-08-25):** spesifikasi awal memakai MTProto (`grammers`). Saat implementasi, ditemukan chunk HLS StreamVault ~1 MB (`-hls_segment_size 1000000`) — jauh di bawah limit Bot API (upload ≤ 50 MB, download ≤ 20 MB). Seluruh jalur B karenanya memakai **Bot API HTTPS biasa** (`sendDocument`/`getFile`) tanpa grammers, tanpa session, tanpa binary uploader Rust. Perilaku & jaminan kompatibilitas (§13) tidak berubah; `api_id`/`api_hash` my.telegram.org tidak lagi diperlukan.

---

## 1. Tujuan & Ruang Lingkup

### Tujuan

1. Simpan segment HLS (`.ts`) di Telegram (channel/supergroup) via **MTProto**, bukan Discord CDN.
2. Proxy segment ke klien Stremio dengan dukungan **HTTP Range** (seek).
3. Dukungan **dual-provider**: Discord tetap default, Telegram opt-in per-instalasi — tanpa rewrite pipeline download/transcode.

### Bukan bagian scope (v1)

- `backend-bun` (Bun/Hono) — hanya `backend` (Rust) disentuh. Port ke Bun jadi kerja lanjutan.
- Akun **user** (Clashdrive-style phone login) — v1 pakai **bot account** (lihat §3).
- Folder/topic mapping ala Clashdrive (folder = forum topic). Storage v1 datar: 1 channel = semua chunk, dibedakan lewat `job_id`.
- Share-link publik / Cloudflare Worker.

---

## 2. Keputusan Desain (ringkasan)

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Protokol | MTProto via **`grammers`** (Rust) | Backend & GHA-runner non-browser; grammers paling mature di Rust; dukungan `bot_sign_in` + `getFile` offset |
| Akun | **Bot account** (`bot_sign_in`) | Tanpa risiko ban ToS (beda dengan Clashdrive yang pakai akun user) |
| Range serving | **Fetch chunk utuh + LRU cache**, serve 206 | Chunk ~1 MB → partial-get MTProto tidak memberi keuntungan nyata; hindari kerumitan alignment 4 KB |
| Provider | **Enum `StorageProvider`** (Discord \| Telegram) | Sudah ada 2 implementasi nyata (Discord eksisting + Telegram baru) — abstraksi di sini bukan spekulasi |
| Chunk→storage | 1 chunk HLS = 1 pesan dokumen | Konsisten dengan desain Discord saat ini (juga 1 pesan/chunk) |
| Index | Reuse `hls_chunks` sebagai manifest | Tidak perlu manifest JSON terpisah ala Clashdrive |

---

## 3. Model Auth & Kredensial

### Bot account (rekomendasi, v1)

- Login: `Client::bot_sign_in(token, api_hash)` → `auth.ImportBotAuthorization`.
- Syarat:
  - `api_id` + `api_hash` dari [my.telegram.org](https://my.telegram.org) (developer creds).
  - Bot token dari BotFather.
  - Bot **harus admin** di channel target upload (perlu `post_messages`).
- Session: `grammers_session::storages::SqliteSession` (persist) atau in-memory per-run.

### Akun user (alternatif, TIDAK di v1)

- `request_login_code` → `sign_in` → `check_password` (OTP + 2FA SRP).
- Clashdrive pakai ini; konsekuensi ToS (akun user sebagai storage) ditanggung user. Catat di docs sebagai opsi, tidak diimplementasi.

### Variabel environment baru

```bash
STREAMVAULT_TG_STORAGE_BOT_TOKEN=   # token BotFather (storage, TERPISAH dari notifikasi)
STREAMVAULT_TG_STORAGE_CHANNEL_ID=  # chat id channel storage (mis. -1001234567890)
STREAMVAULT_STORAGE_PROVIDER=discord  # "discord" (default) | "telegram"
```

Catatan: `STREAMVAULT_TELEGRAM_BOT_TOKEN` / `STREAMVAULT_TELEGRAM_CHANNEL_ID` yang sudah ada **tetap untuk notifikasi** (`backend/src/notifications/telegram.rs`). Jangan dicampur. Jika `STREAMVAULT_TG_STORAGE_*` tidak diset, storage akan fallback ke kredensial `TELEGRAM_*` yang lama demi kompatibilitas dengan setup lama.

---

## 4. Arsitektur

```
                      ┌──────────────────────────────────────────┐
  Stremio ──GET──>    │  Rust backend (Axum)                      │
  /{job}/master.m3u8  │   playlist_handler  (regenerate on-fly)   │
  /{job}/seg_0001.ts  │   chunk_handler ──> fetch_chunk()         │
                      │        │                                  │
                      │        ├─ Discord: reqwest + Range        │
                      │        └─ Telegram: grammers getFile       │
                      │             (LRU cache, file-ref refresh)  │
                      └──────────────────────────────────────────┘
                                        │  ▲
                         upload chunk   │  │  getFile(offset,limit)
                                        ▼  │
                      ┌──────────────────────────────────────────┐
                      │  GHA pipeline (pipeline-runner image)      │
                      │   download → transcode → upload            │
                      │   streamvault-tg-upload (grammers binary)  │
                      └──────────────┬────────────────────────────┘
                                     │ 1 chunk = 1 document message
                                     ▼
                              Telegram DC (channel/supergroup)
```

Data flow upload (Telegram):
1. GHA transcode → `hls/seg_*.ts` (sudah ada, tidak berubah).
2. `streamvault-tg-upload` upload tiap `.ts` → `send_message(document)` → dapat `message_id` + `file_reference`.
3. Kirim `{chunk_index, filename, message_id, file_reference}` via `callback.sh` (pola sama dengan `upload-to-discord.sh`).
4. Backend simpan ke `hls_chunks` (kolom Telegram).

Data flow stream (Telegram):
1. `chunk_handler` resolve `tg_message_id` → `getFile(offset,limit)` → stream bytes.
2. Range request dipotong dari buffer chunk (LRU).
3. `FILE_REFERENCE_EXPIRED` → `channels.getMessages` → file_reference baru → retry (analog `refresh_cdn_url`).

---

## 5. Perubahan Schema

### Migrasi baru (contoh `2026XXXX000003_telegram_storage.sql`)

```sql
ALTER TABLE hls_chunks ADD COLUMN tg_chat_id TEXT;
ALTER TABLE hls_chunks ADD COLUMN tg_message_id TEXT;
ALTER TABLE hls_chunks ADD COLUMN tg_file_reference BLOB;
ALTER TABLE hls_chunks ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'discord';
```

Kolom lama `discord_url` / `discord_message_id` **dipertahankan** (Discord tetap default, tanpa migrasi data lama).

> Alternatif (lebih bersih, lebih invasif): rename/generalisasi `discord_url` → `storage_url`, `discord_message_id` → `storage_ref`. **Dipilih: tambah kolom baru** — zero-risk untuk data eksisting, cutover minim.

### Struct/query yang berubah

- `backend/src/db/queries.rs`:
  - `HlsChunk` (sekitar L55-111) → tambah field `tg_chat_id`, `tg_message_id`, `tg_file_reference`, `storage_provider`.
  - `insert_hls_chunk` (L321-327) → bind field baru.
- `backend/src/api/callbacks.rs`:
  - `progress_callback` (L18-35) → parse field Telegram (`tg_message_id`, `tg_file_reference`) selain `discord_url`.
- `backend-bun/src/db/schema.ts` → **deferred** (lihat §2).

---

## 6. Spesifikasi Komponen

### 6.1 `streamvault-tg-upload` (binary baru, Rust + grammers)

Lokasi: `pipeline/` atau crate terpisah; di-bake ke image `ghcr.io/{repo}/pipeline-runner:latest`.

```
USAGE: streamvault-tg-upload <hls_dir> --token <bot_token> --api-id <id>
       --api-hash <hash> --chat <channel_id> [--concurrency 3]

OUTPUT (JSONL, 1 baris per chunk, sesuai urutan sort seg_*.ts):
{"chunk_index":0,"filename":"seg_0000.ts","message_id":"123","file_reference":"<b64>"}
```

Alur internal:
1. `SqliteSession` (in-memory) → `SenderPool::new(session, api_id)` → `Client::new(handle)` + spawn `runner.run()`.
2. `bot_sign_in(token, api_hash)`.
3. Untuk tiap `.ts` (sorted):
   - `client.upload_file(path)` → `Uploaded`.
   - `client.send_message(chat, InputMessage::text("").document(uploaded))` → `message.id`.
   - Emit JSONL.
4. **Flood control**: concurrency terkontrol (default 3), tangkap `FLOOD_WAIT_N` → sleep N detik → retry (pola `getFloodWaitSeconds` dari Clashdrive).

> `ponytail:` satu binary serba-guna, tidak perlu daemon/service. GHA jalankan sekali per job.

### 6.2 Proxy Telegram di `backend/src/stremio/proxy.rs`

#### State (di `AppState`, `backend/src/app.rs`)

```rust
pub struct AppState {
    // ...existing...
    pub tg_client: Option<grammers_client::Client>,  // lazy-init dari config
    pub chunk_cache: lru::LruCache<(String, String), Vec<u8>>, // (job_id, filename) -> bytes
}
```

Init klien: `SenderPool` + runner task di-spawn saat startup kalau `storage_provider=telegram` atau chunk Telegram pertama diakses (lazy).

#### `fetch_chunk_tg(job_id, filename, range) -> Response`

1. Lookup `tg_chat_id`, `tg_message_id`, `tg_file_reference` dari `hls_chunks`.
2. Cek LRU cache → kalau miss, fetch penuh via `iter_download`:
   ```rust
   let mut it = client.iter_download(&media);
   // kumpulkan semua chunk → Vec<u8> (chunk ~1 MB)
   ```
3. Simpan ke LRU (cap mis. 256 entry / ~256 MB).
4. Potong sesuai `Range: bytes=a-b`, balas `206` + `Content-Range` + `Accept-Ranges: bytes` + `Content-Type: video/mp2t`.

> `ponytail:` fetch utuh + LRU, ganti ke raw `getFile` partial (`offset=floor(a/4096)*4096`) kalau chunk >5 MB di masa depan.

#### `refresh_file_reference(job_id, message_id) -> Option<file_reference>`

1. `channels.getMessages` (atau `client.get_messages`) ambil pesan.
2. Ekstrak `document.file_reference` baru.
3. `UPDATE hls_chunks SET tg_file_reference = ?`.
4. Dipanggil saat `getFile` balas `FILE_REFERENCE_EXPIRED` / `FILEREF_UPGRADE_NEEDED`.

> Analog 1:1 `refresh_cdn_url` / `refresh_cdn_url_with_creds` (proxy.rs L230-298) — ganti endpoint Discord `GET /channels/{id}/messages/{msg_id}` dengan RPC `channels.getMessages`.

#### Pemilihan provider di `chunk_handler`

```rust
match chunk.storage_provider {
    StorageProvider::Discord  => try_fetch_chunk(discord_url, range), // existing
    StorageProvider::Telegram => fetch_chunk_tg(...),                 // new
}
```

### 6.3 Workflow & script GHA

- `.github/scripts/upload-to-telegram.sh` (wrapper baru, analog `upload-to-discord.sh`):
  - Iterasi `.ts`, panggil `streamvault-tg-upload`, parse JSONL, `callback.sh` per chunk.
- `.github/workflows/streamvault-pipeline.yml`:
  - Input baru: `telegram_bot_token`, `telegram_channel_id`, `tg_api_id`, `tg_api_hash`, `storage_provider`.
  - Step `Upload to Discord` (L220-230) → ganti/branch jadi `Upload to Telegram` bila `storage_provider=telegram`.

---

## 7. Error Handling & Retry

| Kondisi | Penanganan |
|---|---|
| `FLOOD_WAIT_N` (upload & getFile) | Sleep N detik, retry, maks 3× lalu gagalkan chunk |
| `FILE_REFERENCE_EXPIRED` / `FILEREF_UPGRADE_NEEDED` | `refresh_file_reference` → retry 1× |
| `FILE_MIGRATE` (303) | `invoke_in_dc` ke DC baru (grammers `iter_download` sudah otomatis) |
| `AUTH_KEY_UNREGISTERED` | `copy_auth_to_dc` (grammers sudah handle di `iter_download`) |
| Token/secret hilang di config | Chunk → `502 Bad Gateway`, log warning, jangan panic |

---

## 8. Keamanan

- `api_id`/`api_hash`/bot token: GitHub Secrets + env, **jangan** di-log ke callback/output.
- Token bot MTProto **tidak pernah** muncul di URL (beda dengan Bot API `/file/bot{token}`) — aman di-proxy.
- Session bot (`SqliteSession`) di backend: file lokal, mode `0600`, path dari env, **jangan** commit.
- `hls_chunks.tg_file_reference` BLOB — data internal, tidak diekspos ke klien.

---

## 9. Rencana Testing

### Unit

- `pick_channel` analog: provider resolution dari `storage_provider` string (mirror `channel.rs` test pattern).
- Range parsing: `parse_range` sudah ada; tambah test slice `bytes=a-b` dari buffer.

### Smoke end-to-end (wajib)

1. Config `storage_provider=telegram`, jalankan `docker compose up -d`.
2. Queue 1 judul kecil (short film) → amati GHA upload → semua `message_id` tersimpan.
3. `curl -r 0-1023 http://localhost:8080/{job}/seg_0000.ts` → expect `206` + `Content-Range`.
4. Buka `hls-debug.html` → play + seek maju/mundur → buffer OK, tidak ada `FILE_REFERENCE_EXPIRED` tak terhandle.
5. Tunggu/force file-ref expire → verifikasi refresh otomatis.

### Regression

- Default `discord` path tetap jalan (jalankan ulang smoke Discord yang ada).

---

## 10. Milestone & Estimasi

| # | Milestone | Deliverable | Estimasi |
|---|---|---|---|
| 1 | Upload helper | `streamvault-tg-upload` + test JSONL | 1 hari |
| 2 | Workflow & script | `upload-to-telegram.sh`, `streamvault-pipeline.yml` | 0.5 hari |
| 3 | Schema + query | migrasi, `queries.rs`, `callbacks.rs` | 0.5 hari |
| 4 | Proxy + state | `proxy.rs`, `app.rs` (SenderPool, LRU) | 1.5 hari |
| 5 | Refresh + flood | `refresh_file_reference`, retry | 0.5 hari |
| 6 | Smoke + regression | §9 terpenuhi | 0.5 hari |
| | **Total** | | **~4.5 hari** |

---

## 11. Risiko & Open Questions

1. **Flood-wait skala penuh** — 7.200 chunk/film; butuh benchmark upload real untuk menetapkan concurrency aman. *Mitigasi: cap concurrency 3, backoff.*
2. **Bot admin requirement** — channel storage harus bot-admin; tanpa ini upload gagal. *Prereq ops.*
3. **Dua backend paralel** (`backend` vs `backend-bun`) — v1 hanya Rust; Bun port = keputusan lanjutan.
4. **User account (Clashdrive-style)** — di luar scope v1; butuh konfirmasi kalau diinginkan (ToS risk).
5. **Chunk size saat ini ~1 MB** — partial-get MTProto belum perlu; kalau nanti chunk diperbesar (>5 MB) upgrade ke raw `getFile` partial.

---

## 12. Pertanyaan untuk konfirmasi sebelum implementasi

1. Bot account atau user account? (v1 default: **bot**)
2. Telegram **menggantikan** Discord, atau **dual-provider** (Discord default, Telegram opt-in)? (v1 default: **dual-provider**)
3. `backend-bun` wajib ikut di v1, atau deferred? (v1 default: **deferred**)

## 13. Jaminan Non-Disturbance (Backward Compatibility)

Desain dibuat **additive-only** terhadap jalur Discord. Default perilaku tidak berubah selama operator tidak men-set `STREAMVAULT_STORAGE_PROVIDER=telegram`.

### Yang benar-benar tidak disentuh

- `try_fetch_chunk()`, `parse_range()`, `refresh_cdn_url()`, `refresh_cdn_url_with_creds()` di `backend/src/stremio/proxy.rs` — logika Discord utuh.
- `.github/scripts/upload-to-discord.sh` — tidak dimodifikasi.
- Data lama di `hls_chunks` — kolom baru via `ALTER TABLE ADD COLUMN` dengan default `'discord'`, tanpa rename/migrasi data.
- Channel notifikasi Telegram — tetap pakai `STREAMVAULT_TELEGRAM_BOT_TOKEN`, tidak bercampur dengan kredensial storage.

### File bersama yang berubah, dan kenapa aman

| File | Perubahan | Guard |
|---|---|---|
| `proxy.rs` `chunk_handler` | tambah 1 cabang `match storage_provider` | Discord path = cabang lama persis seperti sebelumnya |
| `callbacks.rs` L18-35 | parse field `tg_*` opsional | payload Discord tanpa field `tg_*` → cabang skip, bentuk lama tetap valid |
| `queries.rs` | bind kolom baru (nullable) | INSERT lama tetap sah; kolom default `'discord'` |
| `config.rs` | field `Option<String>` baru | absen → provider Telegram tak pernah di-init |
| `app.rs` | `tg_client: Option<...>`, LRU lazy | `None` saat provider discord → nol overhead grammers |
| `streamvault-pipeline.yml` | input `storage_provider` (default `discord`) | step upload branch; jalur default = skrip lama |

### Rollback

Set `STREAMVAULT_STORAGE_PROVIDER=discord` (atau hapus var) → sistem kembali ke perilaku lama penuh. Chunk Telegram yang sudah tersimpan dibiarkan; tidak mengganggu karena hanya diakses lewat cabang provider Telegram.

### Failure isolation

- Init grammers gagal / kredensial salah → error hanya pada chunk ber-provider `telegram` (502), jalur Discord tidak menyentuh kode tersebut.
- GHA run Telegram gagal → job Discord berikutnya tidak terpengaruh (workflow branch per-run).
