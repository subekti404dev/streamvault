# File Selection by Index Design Spec

## Problem

File selection menggunakan `torrent_name` (filename dari Torrentio) sebagai primary key untuk matching file di transmission. Ini bermasalah karena:

- `torrent.title` dari Torrentio adalah label kualitas (e.g. `"1080p"`), bukan filename
- `torrent.filename` dari `behaviorHints.filename` sering kosong
- Fallback `torrent.filename ?? ""` masih kosong untuk banyak stream
- Pipeline detect step gagal match → fallback ke large file yang bisa jadi episode salah
- Season pack torrent: semua file didownload, file 0 (E01) yang ke-transcode

Root cause: file selection menggunakan filename matching yang unreliable. Solusi: pake `file_idx` langsung — index file di transmission.

## Architecture

```
Frontend (Torrentio)   ─→ { torrent_name: "", file_idx: N }
Frontend (Custom)      ─→ { torrent_name: "", file_idx: N (dari inspect) }
     │
     ▼
Backend trigger.ts     ─→ inputs.file_idx
     │
     ▼
Pipeline monitor.sh   ─→ hanya $FILE_IDX, loop sampai file list muncul
     │
     ▼
Pipeline detect step  ─→ cari largest video (monitor udah seleksi)
```

Setiap layer:
- `torrent_name` dikirim sebagai empty string `""` — tidak dipakai di pipeline
- `file_idx` adalah satu-satunya mekanisme file selection
- Single-file torrent (file count ≤1) skip selection

## Perubahan File

### 1. `backend-bun/src/api/search.ts`

**Lokasi:** `searchTorrentio()`, line 258

**Perubahan:** Prioritaskan `stream.behaviorHints?.fileIdx`, baru `stream.fileIdx`, baru `0`.

```typescript
// Before:
const fileIdx = typeof stream.fileIdx === "number" ? stream.fileIdx : 0;

// After:
const fileIdx = 
  typeof stream.behaviorHints?.fileIdx === "number" ? stream.behaviorHints.fileIdx :
  typeof stream.fileIdx === "number" ? stream.fileIdx : 0;
```

Perlu update tipe `TorrentioStream` juga:
```typescript
interface TorrentioStream {
  infoHash?: string;
  name?: string;
  title?: string;
  size?: number;
  fileIdx?: number;
  behaviorHints?: { filename?: string; fileIdx?: number };
}
```

**Edge case:** `behaviorHints.fileIdx` adalah number. Kalo undefined/null, fallback ke `stream.fileIdx`. Kalo dua-duanya undefined, fallback ke 0.

### 2. `backend-bun/src/pipeline/trigger.ts`

**Lokasi:** line 125

**Perubahan:** Kirim `torrent_name: ""` — tidak perlu dikirim karena pipeline gak pake.

```typescript
// Before:
torrent_name: job.torrentName ?? "",

// After:
torrent_name: "",  // ponytail: not used, file_idx only
```

### 3. `dashboard/src/pages/SearchPage.svelte`

**Lokasi:** `addCustomToQueue()`, line 264

**Perubahan:** `torrent_name` jadi `""` untuk custom magnet juga.

```typescript
// Before:
torrent_name: title,

// After:
torrent_name: "",
```

### 4. `.github/scripts/monitor-transmission.sh`

**Lokasi:** Seluruh file

**Perubahan signifikan:**

**a) Signature:** Hapus arg `torrent_name` (6th arg)
```bash
# Usage: monitor-transmission.sh <job_id> <callback_url> <callback_token> <magnet_uri> [file_idx]
JOB_ID="${1:?Missing job_id}"
CALLBACK_URL="${2:?Missing callback_url}"
CALLBACK_TOKEN="${3:?Missing callback_token}"
MAGNET_URI="${4:?Missing magnet_uri}"
FILE_IDX="${5:-}"
```

**b) File selection section (lines 88-191):** Simplifikasi. Hanya index matching.

```
1. FILE_COUNT dari --info-files header
2. FILE_COUNT ≤ 1 → skip (single file)
3. FILE_COUNT > 1 + FILE_IDX kosong → download all
4. FILE_COUNT > 1 + FILE_IDX ada:
   a. Loop 120s (24 × 5s) cek file list muncul
   b. Skip iterasi kalo belum ada file lines
   c. Cari: grep "^[[:space:]]*${IDX}[[:space:]:]" untuk IDX=FILE_IDX dan IDX=FILE_IDX+1
   d. Match pertama → stop → -G all → -g TARGET → start
   e. Abis loop → fallback download all
```

**c) Hapus:** Semua filename matching, TORRENT_NAME guard, partial name match, debug output tiap 5th attempt.
**d) Tambah:** Validasi FILE_IDX numeric (`[[ "$FILE_IDX" =~ ^[0-9]+$ ]]`) sebelum masuk matching loop.

### 5. `.github/workflows/streamvault-pipeline.yml`

**Lokasi:** Lines 112-118 (monitor call)

**Perubahan:** Hapus `"${{ inputs.torrent_name }}"` dari argumen monitor.sh.

**Lokasi:** Lines 138-180 (detect step)

**Perubahan:** Hapus filename matching, langsung fallback ke largest video:

```yaml
- name: Detect source resolution
  id: detect
  shell: bash
  run: |
    INPUT_FILE=$(find ./downloads -type f \
      \( -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.avi" -o -iname "*.mov" \) \
      -not -name "*.log" -not -name "*.torrent" \
      -exec ls -1S {} + 2>/dev/null | head -1)

    if [ -z "$INPUT_FILE" ]; then
      echo "❌ Error: No video file found in ./downloads"
      ls -la ./downloads/
      exit 1
    fi
    echo "input_file=$INPUT_FILE" >> "$GITHUB_OUTPUT"
    echo "Input file: $INPUT_FILE"
    echo "File size: $(du -h "$INPUT_FILE" | cut -f1)"

    # Rest: resolution detection unchanged
```

**Rationale:** Monitor.sh sudah milih file yang bener + udah download cuma file target itu aja. Detect step tinggal cari video apapun yang ada.

### 6. `.github/workflows/streamvault-pipeline.yml`

**Lokasi:** `workflow_dispatch` inputs

Opsional: `torrent_name` input bisa di-hapus. Tapi backward compat → biarin aja, gak dipake.

## Error Handling

| Skenario | Monitor.sh | Detect step |
|----------|------------|-------------|
| Single file | Skip selection (download all) | Ambil satu-satunya video |
| FILE_IDX kosong | Download all | Fallback largest video |
| FILE_IDX ada, file list belum muncul | Loop 120s | — |
| FILE_IDX ada, match | Select file | Ambil video (cuma 1) |
| FILE_IDX ada, no match after 120s | Download all | Fallback largest video |
| FILE_IDX non-numeric | Download all | Fallback largest video |
| 0 file di downloads | — | Error exit |

## Testing

Test scenarios `.github/scripts/validate-transmission.sh` needs update:

1. **Single-file + FILE_IDX kosong** → fallback download all ✓
2. **Single-file + FILE_IDX ada** → fallback download all (ignore idx) ✓
3. **Multi-file + FILE_IDX ada (0-based)** → match file N ✓
4. **Multi-file + FILE_IDX ada (1-based)** → match file N-1 ✓ (karena kedua format di-coba)
5. **Multi-file + FILE_IDX out of range** → download all ✓
6. **Multi-file + FILE_IDX kosong** → download all ✓
