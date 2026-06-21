# Library Detail Page Design

> **Goal:** Tambah halaman detail untuk item di Library — movie dan series. Series detail punya collapsible season/episode sections.

> **Architecture:** Route baru `library/:id` → `LibraryDetailPage.svelte`. Data dari `GET /api/v1/library/:imdb_id` (endpoint baru). Movie: poster, metadata, actions. Series: poster, metadata, collapsible seasons → episodes.

> **Tech Stack:** Svelte 5, existing backend queries

---

## API Design

### GET /api/v1/library/:imdb_id

Response:
```json
{
  "imdb_id": "tt0903747",
  "title": "Breaking Bad",
  "poster_url": "https://...",
  "media_type": "series",
  "jobs": [
    {
      "id": "uuid",
      "title": "Breaking Bad",
      "season": 1,
      "episode": 1,
      "status": "completed",
      "video_resolution": "1080p",
      "duration_seconds": 2700,
      "created_at": "2026-06-20T10:00:00Z"
    }
  ]
}
```

---

## UI Design

### Movie Detail
```
┌─────────────────────────────────────┐
│ ← Back to Library                   │
├─────────────────────────────────────┤
│ ┌─────────┐  The Dark Knight        │
│ │         │  2008 · Movie           │
│ │  🎬     │                         │
│ │ poster  │  [▶ Play]               │
│ │         │  [↻ Retranscode]        │
│ └─────────┘  [✗ Delete]             │
└─────────────────────────────────────┘
```

> ### Series Detail
> ```
> ┌─────────────────────────────────────┐
> │ ← Back to Library                   │
> ├─────────────────────────────────────┤
> │ ┌─────────┐  Breaking Bad           │
> │ │         │  2008 · Series          │
> │ │  📺     │  16 episodes            │
> │ │ poster  │                         │
> │ └─────────┘                         │
> ├─────────────────────────────────────┤
> │ Season 1 (7 episodes)          [▾]  │
> ├─────────────────────────────────────┤
> │ S01E01 - Pilot          1080p 45min │
> │   [▶ Play]                          │
> │ S01E02 - Cat's in the...    [🔍]   │
> │   Search Torrents                   │
> │ S01E03 - ...              1080p 47m │
> │   [▶ Play] [↻] [✗]                 │
> │ ...                                 │
> ├─────────────────────────────────────┤
> │ Season 2 (13 episodes)         [▸]  │
> └─────────────────────────────────────┘
> ```
>
> ### Episode Actions
> - **Completed episode** (ada transcoded video): `▶ Play` `↻ Retranscode` `✗ Delete`
> - **Missing episode** (belum di-transcode): `🔍 Search Torrents` → navigate ke `/search` dengan IMDB ID, season, episode pre-filled
>
> ### Season Collapsible Behavior
> - Default: Season 1 expanded, others collapsed
> - Click season header → toggle expand/collapse
> - Episode count di header season
> - Fetch episode list dari Stremio API saat expand season
- Per-episode: badge, resolution, duration, actions

---

## File Structure

### New Files
- `dashboard/src/pages/LibraryDetailPage.svelte`

### Modified Files
- `dashboard/src/App.svelte` — add route
- `dashboard/src/pages/LibraryPage.svelte` — add link to detail
- `backend/src/api/library.rs` — add detail endpoint
- `backend/src/db/queries.rs` — add detail query
- `dashboard/src/lib/api.ts` — add getLibraryItem method
- `dashboard/src/lib/types.ts` — add LibraryDetail type

---

## Implementation Tasks

### Task 1: Backend - Library Detail Endpoint

**Files:**
- Modify: `backend/src/db/queries.rs`
- Modify: `backend/src/api/library.rs`

### Task 2: Frontend - LibraryDetailPage Component

**Files:**
- Create: `dashboard/src/pages/LibraryDetailPage.svelte`

### Task 3: Frontend - Routing & Navigation

**Files:**
- Modify: `dashboard/src/App.svelte`
- Modify: `dashboard/src/pages/LibraryPage.svelte`
- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/lib/types.ts`

---

## Implementation Plan

### Task 1: Backend - Library Detail Endpoint

**Files:**
- Modify: `backend/src/db/queries.rs`
- Modify: `backend/src/api/library.rs`

- [ ] **Step 1: Add LibraryDetail type to queries.rs**

```rust
// Add after LibraryResponse struct

#[derive(Debug, Serialize)]
pub struct LibraryDetail {
    pub imdb_id: String,
    pub title: Option<String>,
    pub poster_url: Option<String>,
    pub media_type: String,
    pub jobs: Vec<LibraryJob>,
}
```

- [ ] **Step 2: Add get_library_detail query**

```rust
// Add after get_completed_jobs_grouped function

pub async fn get_library_detail(
    pool: &SqlitePool,
    imdb_id: &str,
) -> AppResult<LibraryDetail> {
    // Get all completed jobs for this imdb_id
    let jobs = sqlx::query_as::<_, LibraryJob>(
        r#"
        SELECT id, title, season, episode, status, video_resolution, duration_seconds, created_at
        FROM jobs
        WHERE imdb_id = ? AND status = 'completed'
        ORDER BY season, episode
        "#
    )
    .bind(imdb_id)
    .fetch_all(pool)
    .await?;

    if jobs.is_empty() {
        return Err(AppError::NotFound(format!("No completed jobs for {}", imdb_id)));
    }

    // Get poster from first job or cinemeta_cache
    let first_job = &jobs[0];
    let poster_url = if first_job.poster_url.is_some() {
        // Jobs don't have poster_url in LibraryJob, get from main query
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT poster_url FROM jobs WHERE imdb_id = ? AND poster_url IS NOT NULL LIMIT 1"
        )
        .bind(imdb_id)
        .fetch_optional(pool)
        .await?
        .flatten()
    } else {
        None
    };

    let final_poster = if poster_url.is_some() {
        poster_url
    } else {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT poster_url FROM cinemeta_cache WHERE imdb_id = ?"
        )
        .bind(imdb_id)
        .fetch_optional(pool)
        .await?
        .flatten()
    };

    Ok(LibraryDetail {
        imdb_id: imdb_id.to_string(),
        title: first_job.title.clone(),
        poster_url: final_poster,
        media_type: if jobs.iter().any(|j| j.season.is_some()) {
            "series".to_string()
        } else {
            "movie".to_string()
        },
        jobs,
    })
}
```

- [ ] **Step 3: Add detail handler to library.rs**

```rust
// Add after requeue_job handler

pub async fn get_library_item(
    State(state): State<Arc<AppState>>,
    Path(imdb_id): Path<String>,
) -> AppResult<Json<queries::LibraryDetail>> {
    let detail = queries::get_library_detail(&state.db, &imdb_id).await?;
    Ok(Json(detail))
}
```

- [ ] **Step 4: Add route to app.rs**

```rust
// Add after library requeue route

.route("/api/v1/library/:imdb_id", get(crate::api::library::get_library_item))
```

- [ ] **Step 5: Run cargo check**

Run: `cd backend && cargo check`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd backend && git add src/db/queries.rs src/api/library.rs src/app.rs && git commit -m "feat: add library detail endpoint"
```

---

### Task 2: Frontend - Types & API

**Files:**
- Modify: `dashboard/src/lib/types.ts`
- Modify: `dashboard/src/lib/api.ts`

- [ ] **Step 1: Add LibraryDetail type**

```typescript
// Add after LibraryResponse interface

export interface LibraryDetail {
  imdb_id: string;
  title: string | null;
  poster_url: string | null;
  media_type: string;
  jobs: LibraryJob[];
}
```

- [ ] **Step 2: Add API method**

```typescript
// Add to api object

getLibraryItem: async (imdbId: string): Promise<LibraryDetail> => {
  return handleResponse<LibraryDetail>(
    await fetch(`${BASE}/library/${imdbId}`, { headers: headers() })
  );
},
```

- [ ] **Step 3: Update imports in api.ts**

```typescript
import type { ..., LibraryDetail } from './types';
```

- [ ] **Step 4: Commit**

```bash
cd dashboard && git add src/lib/types.ts src/lib/api.ts && git commit -m "feat: add library detail types and API"
```

---

### Task 3: Frontend - LibraryDetailPage Component

**Files:**
- Create: `dashboard/src/pages/LibraryDetailPage.svelte`

- [ ] **Step 1: Create LibraryDetailPage.svelte**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { LibraryDetail, LibraryJob } from '../lib/types';
  import { formatDuration } from '../lib/types';

  let { id, addToast, navigate }: {
    id: string;
    addToast: (msg: string, type?: string) => void;
    navigate: (e: Event) => void;
  } = $props();

  let detail = $state<LibraryDetail | null>(null);
  let loading = $state(true);
  let expandedSeasons = $state<Set<number>>(new Set([1]));

  onMount(async () => {
    try {
      detail = await api.getLibraryItem(id);
      // Auto-expand first season
      if (detail.media_type === 'series' && detail.jobs.length > 0) {
        const firstSeason = detail.jobs[0]?.season ?? 1;
        expandedSeasons = new Set([firstSeason]);
      }
    } catch (e: any) {
      addToast(`Failed to load detail: ${e.message}`, 'error');
    } finally {
      loading = false;
    }
  });

  function toggleSeason(season: number) {
    if (expandedSeasons.has(season)) {
      expandedSeasons.delete(season);
    } else {
      expandedSeasons.add(season);
    }
    expandedSeasons = expandedSeasons;
  }

  function getSeasons(): number[] {
    if (!detail) return [];
    const seasons = [...new Set(detail.jobs
      .map(j => j.season)
      .filter((s): s is number => s != null)
    )].sort((a, b) => a - b);
    return seasons;
  }

  function getEpisodesForSeason(season: number): LibraryJob[] {
    if (!detail) return [];
    return detail.jobs
      .filter(j => j.season === season)
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  }

  async function requeueJob(jobId: string) {
    try {
      await api.requeueJob(jobId);
      addToast('Job requeued', 'success');
      // Reload detail
      detail = await api.getLibraryItem(id);
    } catch (e: any) {
      addToast(`Requeue failed: ${e.message}`, 'error');
    }
  }

  async function deleteJob(jobId: string) {
    try {
      await api.deleteJob(jobId);
      addToast('Job deleted', 'info');
      detail = await api.getLibraryItem(id);
    } catch (e: any) {
      addToast(`Delete failed: ${e.message}`, 'error');
    }
  }
</script>

<div class="page">
  <!-- Back link -->
  <a href="#library" onclick={navigate} class="back-link">
    ← Back to Library
  </a>

  {#if loading}
    <div class="card"><p class="text-muted">Loading...</p></div>
  {:else if !detail}
    <div class="card"><p class="text-muted">Item not found</p></div>
  {:else}
    <!-- Header -->
    <div class="detail-header">
      <div class="poster-container">
        {#if detail.poster_url}
          <img src={detail.poster_url} alt={detail.title || 'Poster'} class="poster" />
        {:else}
          <div class="poster placeholder">
            {detail.media_type === 'movie' ? '🎬' : '📺'}
          </div>
        {/if}
      </div>
      <div class="detail-info">
        <h1>{detail.title || detail.imdb_id}</h1>
        <div class="meta-badges">
          <span class="badge">{detail.media_type === 'movie' ? 'Movie' : 'Series'}</span>
          {#if detail.media_type === 'series'}
            <span class="badge">{detail.jobs.length} episodes</span>
          {/if}
        </div>
      </div>
    </div>

    <!-- Movie Actions -->
    {#if detail.media_type === 'movie' && detail.jobs.length > 0}
      <div class="actions-card">
        <a
          href="/proxy/hls/{detail.jobs[0].id}/master.m3u8"
          target="_blank"
          class="btn btn-primary"
        >
          ▶ Play
        </a>
        <button class="btn" onclick={() => requeueJob(detail.jobs[0].id)}>
          ↻ Retranscode
        </button>
        <button class="btn btn-danger" onclick={() => deleteJob(detail.jobs[0].id)}>
          ✗ Delete
        </button>
      </div>
    {/if}

    <!-- Series: Season/Episode List -->
    {#if detail.media_type === 'series'}
      <div class="seasons-list">
        {#each getSeasons() as season}
          <div class="season-section">
            <button
              class="season-header"
              onclick={() => toggleSeason(season)}
            >
              <span class="season-title">
                Season {season}
                <span class="episode-count">({getEpisodesForSeason(season).length} episodes)</span>
              </span>
              <span class="season-toggle">
                {expandedSeasons.has(season) ? '▴' : '▸'}
              </span>
            </button>

            {#if expandedSeasons.has(season)}
              <div class="episodes-list">
                {#each getEpisodesForSeason(season) as job}
                  <div class="episode-row">
                    <span class="episode-badge">
                      E{String(job.episode ?? 0).padStart(2, '0')}
                    </span>
                    <span class="episode-info">
                      {job.video_resolution || 'N/A'}
                      {#if job.duration_seconds}
                        · {formatDuration(job.duration_seconds)}
                      {/if}
                    </span>
                    <div class="episode-actions">
                      <a
                        href="/proxy/hls/{job.id}/master.m3u8"
                        target="_blank"
                        class="btn btn-xs btn-primary"
                      >
                        ▶
                      </a>
                      <button
                        class="btn btn-xs"
                        onclick={() => requeueJob(job.id)}
                      >
                        ↻
                      </button>
                      <button
                        class="btn btn-xs btn-danger"
                        onclick={() => deleteJob(job.id)}
                      >
                        ✗
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .back-link {
    display: inline-block;
    margin-bottom: 1.5rem;
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.9rem;
  }
  .back-link:hover {
    color: var(--text);
  }

  .detail-header {
    display: flex;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .poster-container {
    width: 200px;
    flex-shrink: 0;
    aspect-ratio: 2/3;
    border-radius: 8px;
    overflow: hidden;
  }

  .poster {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .poster.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    font-size: 3rem;
  }

  .detail-info h1 {
    margin: 0 0 0.5rem 0;
  }

  .meta-badges {
    display: flex;
    gap: 0.5rem;
  }

  .actions-card {
    display: flex;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 1.5rem;
  }

  .seasons-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .season-section {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .season-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font-size: 1rem;
    font-weight: 600;
  }

  .season-header:hover {
    background: var(--bg-secondary);
  }

  .season-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .episode-count {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .season-toggle {
    font-size: 1.2rem;
    color: var(--text-muted);
  }

  .episodes-list {
    border-top: 1px solid var(--border);
  }

  .episode-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .episode-row:last-child {
    border-bottom: none;
  }

  .episode-badge {
    font-family: monospace;
    color: var(--primary);
    min-width: 40px;
  }

  .episode-info {
    flex: 1;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .episode-actions {
    display: flex;
    gap: 0.25rem;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd dashboard && git add src/pages/LibraryDetailPage.svelte && git commit -m "feat: add LibraryDetailPage component"
```

---

### Task 4: Frontend - Routing & Navigation

**Files:**
- Modify: `dashboard/src/App.svelte`
- Modify: `dashboard/src/pages/LibraryPage.svelte`

- [ ] **Step 1: Import LibraryDetailPage in App.svelte**

```typescript
import LibraryDetailPage from './pages/LibraryDetailPage.svelte';
```

- [ ] **Step 2: Add route in App.svelte**

```svelte
{:else if currentRoute === 'library-detail'}
  <LibraryDetailPage id={routeParams.id || ''} {addToast} {navigate} />
```

- [ ] **Step 3: Update LibraryPage cards to link to detail**

Replace the card click handlers with navigation to detail page:

```svelte
<!-- For movie cards -->
<a href="#library-detail/{group.imdb_id}" onclick={navigate} class="library-card">
  ...
</a>

<!-- For series cards - keep expand button, but card itself links to detail -->
```

- [ ] **Step 4: Commit**

```bash
cd dashboard && git add src/App.svelte src/pages/LibraryPage.svelte && git commit -m "feat: add library detail route and navigation"
```

---

### Task 5: Smoke Test

- [ ] **Step 1: Build backend**

Run: `cd backend && cargo check`
Expected: No errors

- [ ] **Step 2: Build frontend**

Run: `cd dashboard && npm run build`
Expected: No errors

- [ ] **Step 3: Manual test**

1. Navigate to Library → click a movie → detail page loads
2. Click back → returns to Library
3. Navigate to Library → click a series → detail page loads
4. Season 1 expanded by default
5. Click season header → toggle collapse
6. Play/Retranscode/Delete buttons work

---

## Summary

| Task | Description | Est. Time |
|------|-------------|-----------|
| 1 | Backend detail endpoint | 15 min |
| 2 | Frontend types & API | 5 min |
| 3 | LibraryDetailPage component | 25 min |
| 4 | Routing & navigation | 10 min |
| 5 | Smoke test | 5 min |
| **Total** | | **~60 min** |
