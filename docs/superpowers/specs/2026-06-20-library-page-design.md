# Library Page Design

> **Goal:** Halaman baru `/library` untuk browse, putar, dan manage content yang sudah selesai di-transcode, terpisah dari queue.

> **Architecture:** Backend endpoint baru `GET /api/v1/library` meng-query jobs dengan status `completed`, grouped by `imdb_id`, dengan poster fallback ke `cinemeta_cache`. Frontend Svelte page dengan tabs Movies/Series, poster grid, dan expandable episodes.

> **Tech Stack:** Rust/Axum backend, Svelte 5 frontend, SQLite database

---

## API Design

### GET /api/v1/library

Query params:
- `type` (optional): `movie` | `series`, filter by media_type
- `page` (optional): page number, default 1
- `limit` (optional): items per page, default 20

Response:
```json
{
  "items": [
    {
      "imdb_id": "tt1234567",
      "title": "Movie Title",
      "poster_url": "https://...",
      "media_type": "movie",
      "job_count": 1,
      "jobs": [
        {
          "id": "uuid",
          "title": "Movie Title",
          "season": null,
          "episode": null,
          "status": "completed",
          "video_resolution": "1080p",
          "duration_seconds": 7200,
          "created_at": "2026-06-20T10:00:00Z"
        }
      ]
    }
  ],
  "total": 45,
  "page": 1,
  "limit": 20
}
```

### POST /api/v1/library/{job_id}/requeue

Response:
```json
{
  "job_id": "uuid",
  "status": "queued"
}
```

---

## Data Flow

1. Frontend fetch `GET /api/v1/library?type=movie&page=1`
2. Backend query `jobs` WHERE `status = 'completed'`, GROUP BY `imdb_id`
3. Poster: jobs.poster_url → cinemeta_cache.poster_url (fallback)
4. Response: grouped items + pagination metadata
5. User clicks expand (series) → show all episodes from `jobs` array (no pagination)
6. User clicks play → open HLS stream `/proxy/hls/{job_id}/master.m3u8`
7. User clicks requeue → POST `/api/v1/library/{job_id}/requeue`
8. User clicks delete → DELETE `/api/v1/queue/{job_id}`

---

## UI Components

### Navigation
- Route baru: `library`
- Tambah link di drawer: "Library" (icon: 📚)
- Tambah icon button di navbar: 📚

### Page Layout
```
┌─────────────────────────────────────┐
│ Library                             │
│ Browse your completed content       │
├─────────────────────────────────────┤
│ [Movies (12)] [Series (8)]          │
├─────────────────────────────────────┤
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐   │
│ │     │ │     │ │     │ │     │   │
│ │ 🎬  │ │ 🎬  │ │ 📺  │ │ 🎬  │   │
│ │     │ │     │ │     │ │     │   │
│ ├─────┤ ├─────┤ ├─────┤ ├─────┤   │
│ │Title│ │Title│ │Title│ │Title│   │
│ │ ▶ ✗ │ │ ▶ ✗ │ │▶ ▾ ✗│ │ ▶ ✗ │   │
│ └─────┘ └─────┘ └─────┘ └─────┘   │
│                                     │
│ [◀ Prev] Page 1 of 3 [Next ▶]     │
└─────────────────────────────────────┘
```

### Movie Card
- Poster image (200x300, fallback placeholder)
- Title below poster
- Buttons: Play ▶, Retranscode ↻, Delete ✗
- Click card → expand detail? No, flat card

### Series Card
- Poster image (200x300, fallback placeholder)
- Title below poster
- Episode count badge: "5 episodes"
- Buttons: Expand ▾, Delete ✗
- Click expand → show episode list below card

### Episode List (expanded)
```
┌─────────────────────────────────────┐
│ Breaking Bad - 5 episodes           │
├─────────────────────────────────────┤
│ S01E01  1080p  45min  [▶] [↻] [✗] │
│ S01E02  1080p  48min  [▶] [↻] [✗] │
│ S01E03  1080p  47min  [▶] [↻] [✗] │
│ S01E04  1080p  46min  [▶] [↻] [✗] │
│ S01E05  1080p  50min  [▶] [↻] [✗] │
└─────────────────────────────────────┘
```

### Pagination
- Page buttons: Prev, 1, 2, 3, Next
- Current page highlighted
- Disable Prev di page 1, Next di page terakhir

---

## Implementation Tasks

### Task 1: Backend API - Library Endpoint

**Files:**
- Modify: `backend/src/api/mod.rs`
- Create: `backend/src/api/library.rs`
- Modify: `backend/src/db/queries.rs`
- Modify: `backend/src/app.rs` (routing)

### Task 2: Backend API - Requeue Endpoint

**Files:**
- Modify: `backend/src/api/library.rs` (add requeue handler)
- Modify: `backend/src/db/queries.rs` (add requeue query)

### Task 3: Frontend - Library Page Component

**Files:**
- Create: `dashboard/src/pages/LibraryPage.svelte`
- Modify: `dashboard/src/App.svelte` (routing)
- Modify: `dashboard/src/lib/api.ts` (API methods)
- Modify: `dashboard/src/lib/types.ts` (types)

### Task 4: Frontend - Navigation Updates

**Files:**
- Modify: `dashboard/src/App.svelte` (drawer link, navbar icon)

### Task 5: Integration Testing

- Test library API returns correct grouped data
- Test pagination works correctly
- Test requeue functionality
- Test poster fallback to cinemeta_cache
