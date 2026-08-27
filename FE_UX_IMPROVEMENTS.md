# StreamVault FE — UI/UX (Behavior) Improvement Notes

Audit berdasarkan kode aktual di `dashboard/src/`. Fokus pada *behavior* (respons interaksi, feedback, state, navigasi), bukan sekadar visual.

## 1. Toast — manajemen auto-dismiss & Escape salah

**File:** `src/lib/Toast.svelte:8-15`, `src/App.svelte:87-92`

- `$effect` hanya membuat timer untuk toast **terakhir** (`toasts[toasts.length - 1]`). Toast di posisi lebih awal **tidak punya timer** → tidak pernah auto-dismiss. Setiap kali array berubah, effect re-run dan reset timer terakhir (bisa memperpanjang umur toast terakhir secara tak terduga).
- Escape di `App.svelte` memangkas `toasts.slice(0, -1)` (hapus yang **terakhir**), padahal konvensi notifikasi biasanya Escape menutup yang **pertama/teratas**.
- **Fix:** berikan timer per-item (effect terpisah per toast via komponen anak), atau pakai `setTimeout` di `addToast`. Escape sebaiknya menutup toast paling atas.

## 2. SSE memicu full-refetch & flicker

**File:** `QueuePage.svelte:56-64`, `JobDetailPage.svelte:57-69`, `LibraryPage.svelte:52-60`

- Setiap event SSE (`job_progress`, `queue_update`, dll) memanggil `loadQueue()/loadJob()/loadLibrary()` → fetch ulang seluruh data + re-render. Pada job aktif yang update progress tiap detik, ini menyebabkan **flicker, kehilangan scroll position, dan potensi layout jump**.
- Tidak ada debounce/batch merge untuk event bertipe sama.
- **Fix:** update field spesifik secara optimistik dari payload event (mis. `progress_pct`) tanpa refetch penuh; lakukan refetch hanya untuk event struktural (`job_created`, `job_removed`, `job_completed`).

## 3. Aksi destruktif tanpa konfirmasi

**File:** `QueuePage.svelte:46-54`, `132`, `154`

- `deleteJob` (Cancel/Remove) **tidak ada `confirm()`**, berbeda dengan import di Settings (`SettingsPage.svelte:99`) dan delete library (`LibraryDetailPage.svelte:123`) yang pakai confirm. Tidak konsisten & berisiko hapus job aktif secara tidak sengaja.
- **Fix:** tambahkan dialog konfirmasi (atau undo-snackbar) minimal untuk Cancel job yang sedang Processing.

## 4. Double-submit pada "Add to Queue"

**File:** `SearchPage.svelte:191-210`

- `addToQueue(torrent)` tidak punya flag `loading`/`disabled`. User bisa klik berkali-kali → job duplikat di queue. (Kebalikannya, `addCustomToQueue` sudah punya `customAdding`.)
- **Fix:** set `adding` flag, disable tombol saat request berjalan, restore pada finally.

## 5. Navigasi & back-button tidak konsisten

**File:** `App.svelte:54-70`, `SearchPage.svelte:41-58,138`, `JobDetailPage.svelte:120`, `LibraryPage.svelte` (tidak ada back)

- SearchPage pakai `history.pushState` + `popstate` untuk "drill down" (catalog → detail → torrents), **tapi tidak ada tombol Back yang terlihat** di UI (berbeda dengan Job Detail & Library yang punya `<a class="back-link">`). Di mobile, user hanya bisa balik lewat tombol back browser.
- `LibraryDetailPage` tidak punya tombol back selain `<a href="#library">` (ada), tapi SearchPage tidak.
- **Fix:** berikan tombol "← Back" eksplisit di SearchPage yang memanggil `history.back()` / reset state, supaya model navigasi seragam di semua halaman.

## 6. State tab tidak di-reset antar pencarian

**File:** `SearchPage.svelte:118-136`

- `handleQuerySearch` tidak me-reset `searchTab` dan `sourceTab`. Jika user sebelumnya di tab "Series" lalu mencari query baru, hasil bisa tampil di tab yang salah/teralokasi.
- **Fix:** reset `searchTab='movie'`, `sourceTab='results'`, `selectedItem=null`, `result=null` di awal pencarian baru.

## 7. Route selalu reset ke "search" saat reload

**File:** `App.svelte:12`, `74-76`

- `currentRoute` default `'search'`. Saat user reload di halaman Queue/Library/Settings, ia dikembalikan ke Search. Tidak ada persistence halaman terakhir.
- **Fix:** simpan route terakhir di `localStorage` (atau andalkan hash URL) dan restore saat load.

## 8. Settings: tidak ada indikator "unsaved changes"

**File:** `SettingsPage.svelte:49-59,153`

- Tidak ada guard saat user meninggalkan halaman dengan edit belum disimpan. Tidak ada dirty-state indicator, tidak ada `beforeunload`.
- **Fix:** track `dirty` flag; tampilkan badge "Unsaved changes" dan/atau blokir navigasi via `beforeunload` saat dirty.

## 9. Job Detail: delete tidak redirect

**File:** `JobDetailPage.svelte:47-55`

- `deleteJob` set `job = null` → user tertinggal di halaman kosong ("Job not found or removed.") tanpa auto-kembali ke Queue.
- **Fix:** setelah delete sukses, `window.location.hash = '#queue'` (atau `history.back()`).

## 10. Library pagination: tidak ada scroll-reset & jump

**File:** `LibraryPage.svelte:119-137`

- Ganti halaman via Prev/Next tidak meng-scroll ke atas → user tetap di bawah. Tidak ada input "goto page" untuk library besar.
- **Fix:** `window.scrollTo({top:0})` setelah load; tambahkan jump-to-page untuk `totalPages` besar.

## 11. Poster/gambar: tidak ada lazy-load & onerror fallback

**File:** `SearchPage.svelte:391`, `LibraryPage.svelte:99`, `LibraryDetailPage.svelte:150`

- `<img>` eksternal tidak pakai `loading="lazy"` dan tidak ada handler `onerror` → gambar rusak/blank tanpa placeholder, dan memuat semua poster sekaligus.
- **Fix:** tambahkan `loading="lazy"` + `onerror` fallback ke placeholder (sudah ada `.result-poster-placeholder`, tapi tidak dipakai saat img gagal).

## 12. Connection indicator tidak informatif

**File:** `events.ts:32-35`, `App.svelte:143,167`

- Dot SSE berubah connected/disconnected tapi **tanpa tooltip/label teks** dan tanpa notifikasi saat reconnect gagal/berulang. User tidak tahu kenapa progress diam.
- **Fix:** tambahkan `title`/aria-label ("Live" / "Disconnected — retrying in 3s") dan optional toast saat koneksi putus ↺ menyambung kembali.

## 13. Loading state terlalu minim (skeleton vs teks)

**File:** semua halaman (`Loading...` card)

- Seluruh halaman pakai teks "Loading..." statis. Untuk list panjang (Library, Queue) sebaiknya pakai skeleton shimmer agar tidak terasa "hang".
- **Fix:** ganti teks loading dengan skeleton placeholder.

## 14. Validasi input lemah

**File:** `SearchPage.svelte:344-348`, `332-336`

- Input `season`/`episode`/`imdb` tidak divalidasi (bisa < 1, kosong, atau format salah). Tidak ada inline error sebelum request.
- **Fix:** disable tombol Search saat field tidak valid + pesan inline.

## 15. Tidak ada keyboard shortcut / focus management

**File:** `App.svelte` (global)

- Tidak ada shortcut (mis. `/` fokus ke search, `j/k` navigasi list, `Esc` sudah dipakai sebagian). Drawer mobile tidak men-trap focus → aksesibilitas buruk.
- **Fix:** tambahkan focus-trap di drawer, dan shortcut pencarian.

## 16. Search dari Library bisa trigger double-load

**File:** `SearchPage.svelte:104-116`

- `$effect` memantau `routeParams` dan memanggil `handleImdbSearch()` saat ada `imdb_id`. Tapi `onMount` (baris 88-101) juga memanggil `handleImdbSearch()` untuk param yang sama → **dua request beruntun** saat navigasi dari Library.
- **Fix:** dedupe (sudah ada `prevPrefillKey`, tapi `onMount` jalan sebelum effect, sehingga bisa dobel). Gunakan satu mekanisme统一.

---

## Prioritas rekomendasi (dampak tinggi, usaha rendah)

1. #3 konfirmasi aksi destruktif (Cancel/Remove) — cegah data hilang.
2. #2 debounce/optimistic SSE update — hilangkan flicker.
3. #4 disable tombol Add to Queue — cegah duplikat.
4. #1 per-item toast timer — notifikasi jadi bisa diandalkan.
5. #9 redirect setelah delete job — hindari layar kosong.
6. #5 tombol Back eksplisit di Search — konsistensi navigasi.

## Catatan arsitektur

- Routing hash-based (`#route`) tanpa history state terstruktur. Pertimbangkan library router kecil (mis. `svelte-spa-router`/`navaid`) agar back/forward & deep-link konsisten.
- Komponen `Toast`, `api`, `events` sudah terpusat — baik untuk di-refactor tanpa menyentuh banyak halaman.
