# Session Summary — 2026-06-20

## 1. Library Page (from Queue)

**Backend:**
- `GET /api/v1/library` — list completed jobs, grouped by IMDB ID, paginated
- `POST /api/v1/library/:id/requeue` — re-queue job (status guard: only completed/failed)

**Frontend:**
- Tabs Movies/Series
- Poster grid with fallback to cinemeta_cache
- Expandable episodes for series
- Play, retranscode, delete actions
- Pagination (20 items per page)

---

## 2. Library Detail Page

**Backend:**
- `GET /api/v1/library/:imdb_id` — detail single item with all jobs

**Frontend:**
- `LibraryDetailPage.svelte` — poster, metadata, collapsible seasons → episodes
- Movie: play/retranscode/delete buttons
- Series: collapsible season sections → episodes
- Episode actions:
  - Completed: ▶ Play / ↻ Retranscode / ✗ Delete
  - Missing: 🔍 Search → navigate to SearchPage with pre-filled IMDB ID + season + episode

---

## 3. Search Improvements

**Grouping:**
- Search results now split into Movies and Series sections

**Season/Episode Picker:**
- Cascading dropdowns from Stremio API (not manual number input)
- Fallback to number input when metadata unavailable
- Season change → reset episode to 1

---

## 4. GitHub Actions Cleanup

**Behavior:**
- On job completion → auto-delete GitHub Actions run
- Best effort (deletion failure doesn't fail the callback)
- Uses `gh_token` and `gh_repo` from config

---

## 5. Navigation Flow

```
Library Page
  ├── Click poster → Library Detail Page
  │     ├── Movie: Play / Retranscode / Delete
  │     └── Series: Collapsible seasons → episodes
  │           ├── Completed: Play / Retranscode / Delete
  │           └── Missing: 🔍 Search → SearchPage (pre-filled)
  └── Search Page
        ├── Movies section
        └── Series section
              └── Click series → Season/Episode dropdowns → Search Torrents
```

---

## Files Changed

### Backend
| File | Change |
|------|--------|
| `backend/src/api/library.rs` | +list_library, +requeue_job, +get_library_item |
| `backend/src/api/mod.rs` | +library module |
| `backend/src/api/callbacks.rs` | +GH run deletion in complete_callback |
| `backend/src/app.rs` | +library routes |
| `backend/src/db/queries.rs` | +LibraryJob, +LibraryGroup, +LibraryResponse, +LibraryDetail structs + queries |

### Frontend
| File | Change |
|------|--------|
| `dashboard/src/pages/LibraryPage.svelte` | NEW — library grid |
| `dashboard/src/pages/LibraryDetailPage.svelte` | NEW — detail page |
| `dashboard/src/pages/SearchPage.svelte` | +grouping, +dropdown picker, +localStorage prefill |
| `dashboard/src/App.svelte` | +library routes + detail route |
| `dashboard/src/lib/types.ts` | +LibraryJob, +LibraryGroup, +LibraryResponse, +LibraryDetail |
| `dashboard/src/lib/api.ts` | +getLibrary, +requeueJob, +getLibraryItem |

---

## Commits

- `4a058ae` — feat: add Library page for browsing completed content
- `e7b7a08` — feat: improve search UX with grouped results and season/episode picker
